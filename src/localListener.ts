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
        this.mic = new Mic(this.backend, this.cfg.micDevice, this.host.log);
        this.mic.start(d => {
            this.micRemainder = Buffer.concat([this.micRemainder, d]);
            if (!this.pumping) {
                void this.pump();
            }
        });
        this.setStatus('idle');
        this.host.log.info('Local listener ready — listening for the wake word (ioBroker transport, no UDP).');
    }

    async stop(): Promise<void> {
        this.running = false;
        this.playbackProc?.kill();
        this.playbackProc = null;
        await this.mic?.stop();
        this.mic = null;
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
