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
import type { SatelliteConfig } from './config';
import type { SatelliteHost, Logger } from './index';

/** 1280 samples (80 ms) of 16 kHz mono 16-bit PCM per processing frame. */
const FRAME_BYTES = 1280 * 2;
const FRAME_MS = 80;
/** Missed heartbeat ACKs before the satellite assumes the adapter is gone and re-registers. */
const MAX_HEARTBEAT_MISSES = 3;
const RECONNECT_MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));

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
        this.mic?.stop();
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
            await this.startRecording();
        }
    }

    private async startRecording(): Promise<void> {
        this.setStatus('listening');
        this.ttsDiscard = true; // drop any late TTS from a previous turn
        await playPcm(this.plingPcm, AUDIO_SAMPLE_RATE, this.backend, this.cfg.speakerDevice, this.log).done;
        this.ttsDiscard = false;
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
        let msg: { type?: string; ok?: boolean; state?: SatelliteState; sample_rate?: number };
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
            case 'tts_end':
                void this.playTts(msg.sample_rate || AUDIO_SAMPLE_RATE);
                break;
            case 'heartbeat_ack':
                this.awaitingHeartbeatAck = false;
                this.heartbeatMisses = 0;
                break;
        }
    }

    private async playTts(sampleRate: number): Promise<void> {
        const pcm = Buffer.concat(this.ttsChunks);
        this.ttsChunks = [];
        if (!pcm.length) {
            return;
        }
        this.log.info(`Playing reply (${(pcm.length / 2 / sampleRate).toFixed(1)} s @ ${sampleRate} Hz).`);
        const { proc, done } = playPcm(pcm, sampleRate, this.backend, this.cfg.speakerDevice, this.log);
        this.playbackProc = proc; // tracked so the wake word can barge-in
        try {
            await done;
        } finally {
            this.playbackProc = null;
        }
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
