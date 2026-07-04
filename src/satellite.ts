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
import { Mic, playPcm, pling } from './audio';
import { SilenceDetector } from './vad';
import { WakeWord } from './wakeword';
import { ensureModels } from './models';
import { discoverServer } from './mqtt';
import type { SatelliteConfig } from './config';
import type { SatelliteHost, Logger } from './index';

/** 1280 samples (80 ms) of 16 kHz mono 16-bit PCM per processing frame. */
const FRAME_BYTES = 1280 * 2;
const FRAME_MS = 80;

export class Satellite {
    private readonly log: Logger;
    private socket: dgram.Socket | null = null;
    private serverHost = '';
    private serverPort = 0;

    private wakeword!: WakeWord;
    private mic: Mic | null = null;
    private plingPcm: Buffer = Buffer.alloc(0);
    private heartbeatTimer: NodeJS.Timeout | null = null;

    // mic frame assembly
    private micRemainder: Buffer = Buffer.alloc(0);
    private pumping = false;

    // recording state
    private recording = false;
    private silence: SilenceDetector | null = null;
    private preBuffer: Buffer[] = [];

    // tts receiver
    private ttsChunks: Buffer[] = [];
    private ttsDiscard = false;

    private registerResolve: (() => void) | null = null;

    constructor(
        private readonly cfg: SatelliteConfig,
        private readonly host: SatelliteHost,
    ) {
        this.log = host.log;
    }

    async start(): Promise<void> {
        const addr = await this.resolveAddress();
        this.serverHost = addr.host;
        this.serverPort = addr.port;
        this.log.info(`Adapter address: ${this.serverHost}:${this.serverPort}`);

        this.openSocket();

        const models = await ensureModels(this.cfg.modelsDir, this.cfg.wakewordModel, this.log);
        this.wakeword = new WakeWord(models, this.cfg.wakewordThreshold, this.log);
        await this.wakeword.load();
        this.plingPcm = pling();

        await this.register();
        this.heartbeatTimer = setInterval(
            () => this.sendControl({ type: 'heartbeat', device: this.cfg.device }),
            this.cfg.heartbeatIntervalMs,
        );

        this.mic = new Mic(this.cfg.micDevice, this.log);
        this.mic.start(d => this.onMicData(d));
        this.setStatus('idle');
        this.log.info(`Satellite '${this.cfg.device}' ready. Listening for the wake word …`);
    }

    async stop(): Promise<void> {
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

    private async resolveAddress(): Promise<{ host: string; port: number }> {
        if (this.cfg.host) {
            return { host: this.cfg.host, port: this.cfg.port };
        }
        if (this.cfg.mqttBroker) {
            return discoverServer(this.cfg, this.log);
        }
        throw new Error('No adapter address: set "host" (fixed) or "mqttBroker" (discovery) in the config.');
    }

    private openSocket(): void {
        const socket = dgram.createSocket('udp4');
        this.socket = socket;
        socket.on('message', d => this.onMessage(d));
        socket.on('error', e => this.log.error(`UDP error: ${e.message}`));
        socket.bind(this.cfg.listenPort, () => this.log.info(`Listening for TTS on UDP ${this.cfg.listenPort}.`));
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
        if (this.wakeword.triggered(score)) {
            this.log.info(`Wake word detected (score ${(score as number).toFixed(3)}).`);
            this.wakeword.reset();
            await this.startRecording();
        }
    }

    private async startRecording(): Promise<void> {
        this.setStatus('listening');
        this.ttsDiscard = true; // drop any late TTS from a previous turn
        await playPcm(this.plingPcm, AUDIO_SAMPLE_RATE, this.cfg.speakerDevice, this.log);
        this.ttsDiscard = false;
        this.ttsChunks = [];

        this.silence = new SilenceDetector(
            this.cfg.silenceThreshold,
            Math.round(this.cfg.silenceMs / FRAME_MS),
            Math.round(this.cfg.minRecordMs / FRAME_MS),
            Math.round(this.cfg.maxRecordMs / FRAME_MS),
        );
        this.recording = true;
        for (const f of this.preBuffer) {
            this.sendAudio(f);
        }
        this.preBuffer = [];
    }

    private endRecording(): void {
        this.recording = false;
        this.silence = null;
        this.sendControl({ type: 'audio_end', device: this.cfg.device });
        this.log.info('Recording finished — waiting for the reply …');
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
            // 'heartbeat_ack' — nothing to do
        }
    }

    private async playTts(sampleRate: number): Promise<void> {
        const pcm = Buffer.concat(this.ttsChunks);
        this.ttsChunks = [];
        if (!pcm.length) {
            return;
        }
        this.log.info(`Playing reply (${(pcm.length / 2 / sampleRate).toFixed(1)} s @ ${sampleRate} Hz).`);
        await playPcm(pcm, sampleRate, this.cfg.speakerDevice, this.log);
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
