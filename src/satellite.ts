/**
 * Satellite orchestration: resolve the adapter address → register → listen for the wake word →
 * stream the utterance → play the spoken reply. Protocol-compatible with the Hannah satellite.
 */
import * as dgram from 'node:dgram';
import {
    AUDIO_SAMPLE_RATE,
    TYPE_AUDIO,
    TYPE_CONTROL,
    TYPE_TTS,
    decodePacket,
    encodeAudio,
    encodeControl,
    type SatToServer,
    type SatelliteState,
} from './protocol';
import type { ChildProcess } from 'node:child_process';
import { Mic, playPcm, pling, resolveBackend, type AudioBackend } from './audio';
import { SilenceDetector, rms } from './vad';
import { WakeWord } from './wakeword';
import { ensureModels } from './models';
import { parseWakewords, type SatelliteConfig } from './config';
import type { SatelliteHost, Logger } from './index';

/** 1280 samples (80 ms) of 16 kHz mono 16-bit PCM per processing frame. */
const FRAME_BYTES = 1280 * 2;
const FRAME_MS = 80;
/** Missed heartbeat ACKs before the satellite assumes the adapter is gone and re-registers. */
const MAX_HEARTBEAT_MISSES = 3;
const RECONNECT_MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));

/** A volume as an integer percentage 0–100 (anything unreadable counts as full volume). */
function clampVolume(level: number): number {
    const n = Math.round(Number(level));
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 100;
}

export class Satellite {
    private readonly log: Logger;
    private socket: dgram.Socket | null = null;
    private serverHost = '';
    private serverPort = 0;

    private wakeword!: WakeWord;
    private mic: Mic | null = null;
    private readonly backend: AudioBackend;
    private plingPcm: Buffer = Buffer.alloc(0);
    /** Current reply playback process (for barge-in); null when nothing is playing. */
    private playbackProc: ChildProcess | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;

    // mic frame assembly
    private micRemainder: Buffer = Buffer.alloc(0);
    private pumping = false;
    private micBytesLogged = false;

    // wake-word diagnostics (periodic summary)
    private wakeFrames = 0;
    private wakeMaxScore = 0;
    private wakeMaxRms = 0;

    // recording state
    private recording = false;
    private silence: SilenceDetector | null = null;
    private preBuffer: Buffer[] = [];
    private recFrames = 0;
    private recPeakRms = 0;

    // tts receiver
    private ttsChunks: Buffer[] = [];
    private ttsDiscard = false;

    // follow-up: re-open the mic without a wake word after a reply
    /** An utterance was sent and its reply is still to come (an announcement is no reply). */
    private awaitingReply = false;
    /** The adapter asked for the mic once the current playback is over. */
    private listenAfterPlayback = false;
    private waitingFollowUp = false;
    private followUpDeadline = 0;
    private followUpCount = 0;

    /** Playback volume 0–100 (see `SatelliteConfig.volume`). */
    private volume: number;

    private registerResolve: (() => void) | null = null;
    private running = false;
    private heartbeatMisses = 0;
    private awaitingHeartbeatAck = false;
    private reconnecting = false;

    constructor(
        private readonly cfg: SatelliteConfig,
        private readonly host: SatelliteHost,
    ) {
        this.log = host.log;
        this.backend = resolveBackend(cfg.audioBackend);
        this.volume = clampVolume(cfg.volume);
    }

    async start(): Promise<void> {
        this.running = true;
        const addr = this.resolveAddress();
        this.serverHost = addr.host;
        this.serverPort = addr.port;
        this.log.info(`Adapter address: ${this.serverHost}:${this.serverPort}`);

        await this.openSocket();

        const words = parseWakewords(this.cfg.wakewordModel);
        const modelSets = await Promise.all(words.map(w => ensureModels(this.cfg.modelsDir, w, this.log)));
        this.wakeword = new WakeWord(modelSets, this.cfg.wakewordThreshold, this.log);
        await this.wakeword.load();
        this.plingPcm = pling();

        // Retry until the adapter answers, so the satellite survives the adapter being down at boot.
        await this.registerWithRetry();
        this.reportVolume();
        this.heartbeatTimer = setInterval(() => this.heartbeatTick(), this.cfg.heartbeatIntervalMs);

        this.mic = new Mic(this.backend, this.cfg.micDevice, this.log);
        this.mic.start(d => this.onMicData(d));
        this.setStatus('idle');
        this.log.info(`Satellite '${this.cfg.device}' ready. Listening for the wake word …`);
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        await this.mic?.stop();
        this.mic = null;
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            await new Promise<void>(res => socket.close(() => res()));
        }
    }

    // ── setup ──────────────────────────────────────────────────────────────

    private resolveAddress(): { host: string; port: number } {
        if (!this.cfg.host) {
            throw new Error('No adapter address: set "host" (and "port") in the config.');
        }
        return { host: this.cfg.host, port: this.cfg.port };
    }

    private openSocket(): Promise<void> {
        return new Promise((resolve, reject) => {
            const socket = dgram.createSocket('udp4');
            this.socket = socket;
            socket.on('message', d => this.onMessage(d));
            socket.on('error', e => this.log.error(`UDP error: ${e.message}`));
            socket.once('error', reject);
            socket.bind(this.cfg.listenPort, () => {
                this.log.info(`Listening for TTS on UDP ${this.cfg.listenPort}.`);
                resolve();
            });
        });
    }

    /** Register, retrying with exponential backoff until the adapter acknowledges (or we stop). */
    private async registerWithRetry(): Promise<void> {
        let backoff = 1000;
        while (this.running) {
            try {
                await this.register();
                this.awaitingHeartbeatAck = false;
                this.heartbeatMisses = 0;
                return;
            } catch (e) {
                this.log.warn(`${(e as Error).message} — retrying in ${Math.round(backoff / 1000)} s …`);
                await sleep(backoff);
                backoff = Math.min(backoff * 2, RECONNECT_MAX_BACKOFF_MS);
            }
        }
    }

    /** Triggered when heartbeats stop being acknowledged: re-register (adapter probably restarted). */
    private async reconnect(): Promise<void> {
        if (this.reconnecting || !this.running) {
            return;
        }
        this.reconnecting = true;
        this.heartbeatMisses = 0;
        this.awaitingHeartbeatAck = false;
        this.log.warn('Adapter unreachable — re-registering …');
        try {
            await this.registerWithRetry();
            this.reportVolume();
            this.log.info('Re-registered with the adapter.');
        } finally {
            this.reconnecting = false;
        }
    }

    private heartbeatTick(): void {
        if (this.reconnecting) {
            return;
        }
        if (this.awaitingHeartbeatAck) {
            this.heartbeatMisses++;
            this.log.warn(`Heartbeat not acknowledged (${this.heartbeatMisses}/${MAX_HEARTBEAT_MISSES}).`);
            if (this.heartbeatMisses >= MAX_HEARTBEAT_MISSES) {
                void this.reconnect();
                return;
            }
        }
        this.awaitingHeartbeatAck = true;
        this.sendControl({ type: 'heartbeat', device: this.cfg.device });
    }

    private register(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.registerResolve = resolve;
            this.sendControl({
                type: 'register',
                device: this.cfg.device,
                room: this.cfg.room,
                listen_port: this.cfg.listenPort,
            });
            this.log.info(`Registration sent to ${this.serverHost}:${this.serverPort} (device '${this.cfg.device}').`);
            setTimeout(() => {
                if (this.registerResolve) {
                    this.registerResolve = null;
                    reject(new Error(`registration timed out after ${this.cfg.registrationTimeoutMs} ms`));
                }
            }, this.cfg.registrationTimeoutMs);
        });
    }

    // ── microphone → wake word → recording ─────────────────────────────────

    private onMicData(chunk: Buffer): void {
        if (!this.micBytesLogged) {
            this.micBytesLogged = true;
            this.log.info(`Microphone is producing audio (first chunk ${chunk.length} bytes).`);
        }
        this.micRemainder = Buffer.concat([this.micRemainder, chunk]);
        if (!this.pumping) {
            void this.pump();
        }
    }

    private async pump(): Promise<void> {
        this.pumping = true;
        try {
            while (this.micRemainder.length >= FRAME_BYTES) {
                const frame = Buffer.from(this.micRemainder.subarray(0, FRAME_BYTES));
                this.micRemainder = this.micRemainder.subarray(FRAME_BYTES);
                await this.handleFrame(frame);
            }
        } catch (e) {
            this.log.error(`frame processing error: ${(e as Error).message}`);
        } finally {
            this.pumping = false;
        }
    }

    private async handleFrame(frame: Buffer): Promise<void> {
        if (this.recording) {
            this.sendAudio(frame);
            this.recFrames++;
            const level = rms(frame);
            if (level > this.recPeakRms) {
                this.recPeakRms = level;
            }
            if (this.silence!.push(frame)) {
                this.endRecording();
            }
            return;
        }

        // Follow-up window: the mic is open without a wake word; speech starts a recording, silence until
        // the deadline drops back to wake-word mode (nothing is streamed, so no STT is paid for silence).
        if (this.waitingFollowUp) {
            if (Date.now() > this.followUpDeadline) {
                this.waitingFollowUp = false;
                this.log.debug('Follow-up window closed — back to the wake word.');
                this.setStatus('idle');
                return;
            }
            if (rms(frame) >= this.cfg.silenceThreshold) {
                this.waitingFollowUp = false;
                this.log.info('Follow-up speech detected — continuing the conversation.');
                await this.startRecording(false); // no beep: the user is already talking
                this.sendAudio(frame); // keep the speech onset
                this.recFrames++;
                this.silence!.push(frame);
            }
            return;
        }

        // Wake-word listening: keep a rolling pre-buffer so speech during inference is not lost.
        this.preBuffer.push(frame);
        if (this.preBuffer.length > this.cfg.preBufferChunks) {
            this.preBuffer.shift();
        }
        const score = await this.wakeword.process(frame);

        // Periodic diagnostics: every ~2 s report how many frames ran and the peak score, so you can
        // watch the score rise while saying the wake word and tune `wakewordThreshold`.
        this.wakeFrames++;
        if (score !== null && score > this.wakeMaxScore) {
            this.wakeMaxScore = score;
        }
        const level = rms(frame);
        if (level > this.wakeMaxRms) {
            this.wakeMaxRms = level;
        }
        if (this.wakeFrames >= 25) {
            this.log.debug(
                `wake: ${this.wakeFrames} frames, peak mic RMS ${this.wakeMaxRms.toFixed(0)}, ` +
                    `peak score ${this.wakeMaxScore.toFixed(3)} (threshold ${this.cfg.wakewordThreshold})`,
            );
            this.wakeFrames = 0;
            this.wakeMaxScore = 0;
            this.wakeMaxRms = 0;
        }

        if (this.wakeword.triggered(score)) {
            this.log.info(`Wake word detected (score ${(score as number).toFixed(3)}).`);
            // Barge-in: if a reply is currently playing, stop it so the user can interrupt.
            if (this.cfg.bargeIn && this.playbackProc) {
                this.log.info('Barge-in: stopping playback.');
                this.playbackProc.kill();
                this.playbackProc = null;
            }
            this.wakeword.reset();
            this.followUpCount = 0; // a fresh wake word starts a new conversation
            await this.startRecording();
        }
    }

    private async startRecording(beep = true): Promise<void> {
        this.setStatus('listening');
        this.listenAfterPlayback = false;
        if (beep) {
            this.ttsDiscard = true; // drop any late TTS from a previous turn
            await playPcm(this.scaled(this.plingPcm), AUDIO_SAMPLE_RATE, this.backend, this.cfg.speakerDevice, this.log)
                .done;
            this.ttsDiscard = false;
        }
        this.ttsChunks = [];

        // Drop everything captured up to now (the beep echo + any inference backlog) so recording runs
        // in real time — otherwise the silence detector races through buffered quiet frames and ends the
        // utterance before you finish speaking (→ the adapter's STT gets silence → "(empty)").
        this.micRemainder = Buffer.alloc(0);
        this.preBuffer = [];
        this.recFrames = 0;
        this.recPeakRms = 0;
        this.silence = new SilenceDetector(
            this.cfg.silenceThreshold,
            Math.round(this.cfg.silenceMs / FRAME_MS),
            Math.round(this.cfg.minRecordMs / FRAME_MS),
            Math.round(this.cfg.maxRecordMs / FRAME_MS),
        );
        this.recording = true;
        this.log.info('Beep done — listening for your command …');
    }

    private endRecording(): void {
        this.recording = false;
        this.silence = null;
        this.awaitingReply = true;
        this.sendControl({ type: 'audio_end', device: this.cfg.device });
        const maxFrames = Math.round(this.cfg.maxRecordMs / FRAME_MS);
        const reason = this.recFrames >= maxFrames ? 'max length' : 'silence';
        this.log.info(
            `Recording finished: ${this.recFrames} frames (${this.recFrames * FRAME_MS} ms), ` +
                `peak RMS ${this.recPeakRms.toFixed(0)}, ended on ${reason} — audio_end sent.`,
        );
    }

    // ── incoming UDP (control + TTS) ───────────────────────────────────────

    private onMessage(data: Buffer): void {
        if (!data.length) {
            return;
        }
        const { type, payload } = decodePacket(data);
        if (type === TYPE_AUDIO) {
            return; // satellites do not receive audio
        }
        if (type === TYPE_TTS) {
            if (!this.ttsDiscard) {
                this.ttsChunks.push(Buffer.from(payload));
            }
            return;
        }
        if (type !== TYPE_CONTROL) {
            return;
        }
        let msg: {
            type?: string;
            ok?: boolean;
            state?: SatelliteState;
            sample_rate?: number;
            listen?: boolean;
            level?: number;
            delta?: number;
        };
        try {
            msg = JSON.parse(payload.toString('utf8'));
        } catch {
            return;
        }
        switch (msg.type) {
            case 'registered':
                if (msg.ok && this.registerResolve) {
                    this.log.info('Registration confirmed (ACK).');
                    this.registerResolve();
                    this.registerResolve = null;
                }
                break;
            case 'reregister':
                this.register().catch(e => this.log.warn(`re-register failed: ${(e as Error).message}`));
                break;
            case 'status':
                if (msg.state) {
                    this.setStatus(msg.state);
                }
                break;
            case 'tts_end': {
                const isReply = this.awaitingReply;
                this.awaitingReply = false;
                if (msg.listen) {
                    this.listenAfterPlayback = true;
                }
                void this.playTts(msg.sample_rate || AUDIO_SAMPLE_RATE, isReply);
                break;
            }
            case 'listen':
                // Sent right after an announcement that asks something: its audio is (about to be) playing,
                // so the mic opens when it is over — otherwise the question itself would be recorded.
                if (this.playbackProc || this.ttsChunks.length) {
                    this.listenAfterPlayback = true;
                } else {
                    this.openFollowUp(true);
                }
                break;
            case 'volume': {
                const level = typeof msg.level === 'number' ? msg.level : this.volume + (Number(msg.delta) || 0);
                void this.setVolume(level);
                break;
            }
            case 'heartbeat_ack':
                this.awaitingHeartbeatAck = false;
                this.heartbeatMisses = 0;
                break;
        }
    }

    private async playTts(sampleRate: number, isReply: boolean): Promise<void> {
        const pcm = Buffer.concat(this.ttsChunks);
        this.ttsChunks = [];
        if (!pcm.length) {
            this.listenAfterPlayback = false;
            return;
        }
        this.log.info(`Playing reply (${(pcm.length / 2 / sampleRate).toFixed(1)} s @ ${sampleRate} Hz).`);
        const { proc, done } = playPcm(this.scaled(pcm), sampleRate, this.backend, this.cfg.speakerDevice, this.log);
        this.playbackProc = proc; // tracked so the wake word can barge-in
        try {
            await done;
        } finally {
            this.playbackProc = null;
        }
        // Barge-in started a new recording meanwhile — that one is the conversation now.
        if (this.recording) {
            this.listenAfterPlayback = false;
            return;
        }
        const asked = this.listenAfterPlayback;
        this.listenAfterPlayback = false;
        // The adapter asked back, or follow-up is on and this was the answer to something we said.
        if (asked || (this.cfg.followUp && isReply)) {
            this.openFollowUp(asked);
        } else {
            this.followUpCount = 0;
        }
    }

    /**
     * Keep the mic open without a wake word for `followUpWindowMs`. Limited to `maxFollowUps` turns in a
     * row, so a misunderstanding that keeps asking back cannot hold the mic open forever.
     */
    private openFollowUp(asked: boolean): void {
        if (!this.running || this.recording) {
            return;
        }
        if (this.followUpCount >= this.cfg.maxFollowUps) {
            this.log.info('Follow-up limit reached — say the wake word to continue.');
            this.followUpCount = 0;
            this.setStatus('idle');
            return;
        }
        this.followUpCount++;
        this.micRemainder = Buffer.alloc(0); // what the mic heard during playback is the reply itself
        this.preBuffer = [];
        this.waitingFollowUp = true;
        this.followUpDeadline = Date.now() + this.cfg.followUpWindowMs;
        this.setStatus('listening');
        if (asked) {
            this.log.info('Mic ON — the assistant asked a question, listening for your answer (no wake word).');
        } else {
            this.log.debug('Follow-up window open (mic on, no wake word).');
        }
    }

    // ── volume ─────────────────────────────────────────────────────────────

    /**
     * Set the playback volume (0–100) and report it to the adapter. Called for the adapter's `volume`
     * command, and by a host whose own volume control changed (`notifyHost: false` — it already knows).
     */
    async setVolume(level: number, notifyHost = true): Promise<void> {
        this.volume = clampVolume(level);
        this.log.info(`Volume ${this.volume}%.`);
        if (notifyHost && this.host.onVolume) {
            try {
                await this.host.onVolume(this.volume);
            } catch (e) {
                this.log.warn(`Applying the volume failed: ${(e as Error).message}`);
            }
        }
        this.reportVolume();
    }

    private reportVolume(): void {
        this.sendControl({ type: 'volume', device: this.cfg.device, level: this.volume });
    }

    /**
     * The audio to play at the current volume. With a host mixer it stays unchanged; otherwise the samples
     * are scaled — on a squared curve, because a linear one sounds barely quieter until the very end.
     */
    private scaled(pcm: Buffer): Buffer {
        if (this.host.mixerVolume || this.volume >= 100) {
            return pcm;
        }
        const gain = (this.volume / 100) ** 2;
        const out = Buffer.alloc(pcm.length - (pcm.length % 2));
        for (let i = 0; i < out.length; i += 2) {
            out.writeInt16LE(Math.round(pcm.readInt16LE(i) * gain), i);
        }
        return out;
    }

    // ── senders / status ───────────────────────────────────────────────────

    private sendAudio(pcm: Buffer): void {
        this.socket?.send(encodeAudio(pcm), this.serverPort, this.serverHost);
    }

    private sendControl(msg: SatToServer): void {
        this.socket?.send(encodeControl(msg), this.serverPort, this.serverHost);
    }

    private setStatus(state: SatelliteState): void {
        this.host.onStatus?.(state);
    }
}
