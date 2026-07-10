/**
 * Local wake-word + record loop with NO network transport. Captures the microphone, detects the wake
 * word, records one utterance (until silence), hands the full PCM to `host.onUtterance`, and plays the
 * reply audio it returns. The ioBroker adapter uses this to exchange audio with the assistant over the
 * message bus (sendTo) instead of the UDP voice protocol — so no UDP port and STT/TTS stay central.
 *
 * Standalone (ESP / no ioBroker) satellites keep using the UDP `Satellite` class; this is the
 * ioBroker-native alternative.
 */
import type { ChildProcess } from 'node:child_process';
import { WakeWord } from './wakeword';
import { ensureModels } from './models';
import { Mic, playPcm, pling, resolveBackend, type AudioBackend } from './audio';
import { SilenceDetector, rms } from './vad';
import { AUDIO_SAMPLE_RATE } from './protocol';
import { parseWakewords, type SatelliteConfig } from './config';
import type { Logger, SatelliteState } from './index';

const FRAME_BYTES = 1280 * 2; // 80 ms @ 16 kHz mono 16-bit
const FRAME_MS = 80;

export interface LocalListenerHost {
    log: Logger;
    onStatus?(state: SatelliteState): void;
    /**
     * A complete recorded utterance (16 kHz mono 16-bit PCM). Return the reply audio to play back, or
     * null to stay silent (e.g. nothing recognised).
     */
    onUtterance(pcm: Buffer, sampleRate: number): Promise<{ pcm: Buffer; sampleRate: number } | null>;
    /**
     * Microphone capture died and could not be (re)opened — `message` describes it (device + last error).
     * Called on each failed (re)start attempt; the listener keeps retrying with backoff. The adapter can
     * surface this as a `micError` state so a deaf satellite is visible instead of silently failing.
     */
    onMicError?(message: string): void;
    /** Microphone capture is working again (audio flowing) after a prior error — clears the error state. */
    onMicRecovered?(): void;
}

export class LocalListener {
    private wakeword!: WakeWord;
    private mic: Mic | null = null;
    private readonly backend: AudioBackend;
    private plingPcm: Buffer = Buffer.alloc(0);

    private micRemainder: Buffer = Buffer.alloc(0);
    private preBuffer: Buffer[] = [];
    private recording = false;
    private recChunks: Buffer[] = [];
    private silence: SilenceDetector | null = null;
    private pumping = false;
    private running = false;
    private playbackProc: ChildProcess | null = null;
    /** Follow-up: after a reply, listen for the user to keep talking without the wake word. */
    private waitingFollowUp = false;
    private followUpDeadline = 0;
    private followUpCount = 0;

    // ── Mic resilience: auto-restart with backoff + ALSA device fallback ─────────
    /** True once audio is flowing from the current capture (resets the backoff / clears the error). */
    private micHealthy = false;
    /** Consecutive failed (re)starts, for exponential backoff. */
    private micRetries = 0;
    /** Pending restart timer (cleared on stop). */
    private micRestartTimer: ReturnType<typeof setTimeout> | null = null;
    /** Candidate capture devices to cycle through on repeated failure. */
    private micCandidates: string[] = [];
    private micCandidateIdx = 0;
    /** Whether we are currently in the mic-error state (so we only log recovery when relevant). */
    private micErrored = false;

    constructor(
        private readonly cfg: SatelliteConfig,
        private readonly host: LocalListenerHost,
    ) {
        this.backend = resolveBackend(cfg.audioBackend);
    }

    async start(): Promise<void> {
        const words = parseWakewords(this.cfg.wakewordModel);
        const modelSets = await Promise.all(words.map(w => ensureModels(this.cfg.modelsDir, w, this.host.log)));
        this.wakeword = new WakeWord(modelSets, this.cfg.wakewordThreshold, this.host.log);
        await this.wakeword.load();
        this.plingPcm = pling();
        this.running = true;
        this.micCandidates = this.buildMicCandidates();
        this.micCandidateIdx = 0;
        this.micRetries = 0;
        this.startMic();
        this.setStatus('idle');
        this.host.log.info('Local listener ready — listening for the wake word (ioBroker transport, no UDP).');
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.micRestartTimer) {
            clearTimeout(this.micRestartTimer);
            this.micRestartTimer = null;
        }
        this.playbackProc?.kill();
        this.playbackProc = null;
        await this.mic?.stop();
        this.mic = null;
    }

    /**
     * Devices to try for capture. An explicitly configured device is respected (and just retried on
     * failure). When it is empty/'default' on ALSA — the classic "no capture slave" case — cycle through
     * common hardware capture devices so a wrong 'default' recovers automatically.
     */
    private buildMicCandidates(): string[] {
        const d = (this.cfg.micDevice || '').trim();
        if (d && d !== 'default') {
            return [d];
        }
        if (this.backend !== 'alsa') {
            return [d]; // ffmpeg/dshow/avfoundation: only the configured/default device
        }
        return ['default', 'plughw:1,0', 'plughw:0,0', 'plughw:2,0'];
    }

    /** (Re)start microphone capture on the current candidate device, wiring recovery + failure handling. */
    private startMic(): void {
        if (!this.running) {
            return;
        }
        this.micHealthy = false;
        const device = this.micCandidates[this.micCandidateIdx] || this.cfg.micDevice;
        this.mic = new Mic(this.backend, device, this.host.log);
        this.mic.start(
            d => {
                // First data after a (re)start → capture is healthy again.
                if (!this.micHealthy) {
                    this.micHealthy = true;
                    this.micRetries = 0;
                    if (this.micErrored) {
                        this.micErrored = false;
                        this.host.log.info(`Microphone recovered (device: ${device || 'default'}).`);
                        this.host.onMicRecovered?.();
                    }
                }
                this.micRemainder = Buffer.concat([this.micRemainder, d]);
                if (!this.pumping) {
                    void this.pump();
                }
            },
            info => this.onMicExit(device, info),
        );
    }

    /** Handle an unexpected capture exit: surface the error, advance the device, and restart with backoff. */
    private onMicExit(device: string, info: { code: number | null; lastErr: string; hint: string }): void {
        if (!this.running) {
            return;
        }
        this.micHealthy = false;
        this.micErrored = true;
        const message = `Microphone capture failed on '${device || 'default'}' (exit ${info.code ?? '?'})${info.lastErr ? `: ${info.lastErr}` : ''}.${info.hint}`;
        this.host.onMicError?.(message);
        // Try the next candidate device on the next attempt (wraps around).
        if (this.micCandidates.length > 1) {
            this.micCandidateIdx = (this.micCandidateIdx + 1) % this.micCandidates.length;
        }
        // Exponential backoff, capped at 30 s, so a transient I/O error recovers on its own.
        const delay = Math.min(30_000, 2_000 * 2 ** Math.min(this.micRetries, 4));
        this.micRetries++;
        this.host.log.warn(
            `Restarting microphone capture in ${Math.round(delay / 1000)}s (attempt ${this.micRetries}).`,
        );
        if (this.micRestartTimer) {
            clearTimeout(this.micRestartTimer);
        }
        this.micRestartTimer = setTimeout(() => {
            this.micRestartTimer = null;
            void this.mic?.stop().catch(() => {});
            this.startMic();
        }, delay);
    }

    private setStatus(state: SatelliteState): void {
        this.host.onStatus?.(state);
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
            this.host.log.error(`frame processing error: ${(e as Error).message}`);
        } finally {
            this.pumping = false;
        }
    }

    private async handleFrame(frame: Buffer): Promise<void> {
        if (this.recording) {
            this.recChunks.push(frame);
            if (this.silence!.push(frame)) {
                await this.endRecording();
            }
            return;
        }
        // Follow-up window: keep the mic open after a reply so the user can continue without the wake word.
        if (this.waitingFollowUp) {
            if (Date.now() > this.followUpDeadline) {
                this.waitingFollowUp = false;
                this.setStatus('idle'); // nobody continued → back to wake-word mode
                return;
            }
            if (rms(frame) >= this.cfg.silenceThreshold) {
                this.waitingFollowUp = false;
                this.host.log.info('Follow-up speech detected — continuing the conversation.');
                await this.startRecording(false); // no wake beep
                this.recChunks.push(frame); // keep the speech onset
            }
            return;
        }
        // Wake-word listening with a rolling pre-buffer so speech during inference is not lost.
        this.preBuffer.push(frame);
        if (this.preBuffer.length > this.cfg.preBufferChunks) {
            this.preBuffer.shift();
        }
        const score = await this.wakeword.process(frame);
        if (this.wakeword.triggered(score)) {
            this.host.log.info(`Wake word detected (score ${(score as number).toFixed(3)}).`);
            this.wakeword.reset();
            this.followUpCount = 0; // a fresh wake word starts a new conversation
            await this.startRecording();
        }
    }

    private async startRecording(beep = true): Promise<void> {
        this.setStatus('listening');
        if (beep) {
            await playPcm(this.plingPcm, AUDIO_SAMPLE_RATE, this.backend, this.cfg.speakerDevice, this.host.log).done;
        }
        // Drop the beep echo + inference backlog so recording runs in real time (else the silence
        // detector races through buffered quiet frames and ends the utterance too early).
        this.micRemainder = Buffer.alloc(0);
        this.preBuffer = [];
        this.recChunks = [];
        this.silence = new SilenceDetector(
            this.cfg.silenceThreshold,
            Math.round(this.cfg.silenceMs / FRAME_MS),
            Math.round(this.cfg.minRecordMs / FRAME_MS),
            Math.round(this.cfg.maxRecordMs / FRAME_MS),
        );
        this.recording = true;
    }

    private async endRecording(): Promise<void> {
        this.recording = false;
        const pcm = Buffer.concat(this.recChunks);
        this.recChunks = [];
        this.setStatus('processing');
        let spoke = false;
        try {
            const reply = await this.host.onUtterance(pcm, AUDIO_SAMPLE_RATE);
            if (reply && reply.pcm.length && this.running) {
                spoke = true;
                this.setStatus('speaking');
                const { proc, done } = playPcm(
                    reply.pcm,
                    reply.sampleRate,
                    this.backend,
                    this.cfg.speakerDevice,
                    this.host.log,
                );
                this.playbackProc = proc;
                try {
                    await done;
                } finally {
                    this.playbackProc = null;
                }
            }
        } catch (e) {
            this.host.log.error(`utterance processing failed: ${(e as Error).message}`);
        } finally {
            this.micRemainder = Buffer.alloc(0); // discard audio captured while processing/speaking
            this.preBuffer = [];
            // Open a follow-up window (mic stays on, no wake word) if the assistant answered and we still
            // have follow-up budget — enables "…and the kitchen too" without repeating the wake word.
            if (this.cfg.followUp && spoke && this.running && this.followUpCount < this.cfg.maxFollowUps) {
                this.followUpCount++;
                this.waitingFollowUp = true;
                this.followUpDeadline = Date.now() + this.cfg.followUpWindowMs;
                this.setStatus('listening');
            } else {
                this.followUpCount = 0;
                this.waitingFollowUp = false;
                this.setStatus('idle');
            }
        }
    }
}
