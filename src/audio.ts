/**
 * Audio I/O via ALSA `arecord`/`aplay` (spawned) — robust on a Pi, no native build.
 * Use a `plughw:CARD,DEV` device so ALSA resamples automatically (capture always at 16 kHz).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { AUDIO_SAMPLE_RATE } from './protocol';
import type { Logger } from './index';

/** Continuous microphone capture at 16 kHz mono 16-bit; emits raw PCM chunks. */
export class Mic {
    private proc: ChildProcess | null = null;

    constructor(
        private readonly device: string,
        private readonly log: Logger,
    ) {}

    start(onData: (pcm: Buffer) => void): void {
        const args = ['-q', '-t', 'raw', '-f', 'S16_LE', '-c', '1', '-r', String(AUDIO_SAMPLE_RATE)];
        if (this.device && this.device !== 'default') {
            args.push('-D', this.device);
        }
        this.proc = spawn('arecord', args);
        this.proc.stdout?.on('data', (d: Buffer) => onData(d));
        this.proc.stderr?.on('data', (d: Buffer) => this.log.debug(`arecord: ${d.toString().trim()}`));
        this.proc.on('error', e =>
            this.log.error(`arecord failed: ${e.message} — is 'alsa-utils' installed (sudo apt install alsa-utils)?`),
        );
        this.log.info(`Microphone capture started (${this.device || 'default'} @ ${AUDIO_SAMPLE_RATE} Hz).`);
    }

    stop(): void {
        this.proc?.kill();
        this.proc = null;
    }
}

/** Play raw mono 16-bit PCM through `aplay` at the given rate; resolves when playback finishes. */
export function playPcm(pcm: Buffer, sampleRate: number, device: string, log: Logger): Promise<void> {
    return new Promise<void>(resolve => {
        const args = ['-q', '-t', 'raw', '-f', 'S16_LE', '-c', '1', '-r', String(sampleRate)];
        if (device && device !== 'default') {
            args.push('-D', device);
        }
        const proc = spawn('aplay', args);
        proc.on('close', () => resolve());
        proc.on('error', e => {
            log.error(`aplay failed: ${e.message}`);
            resolve();
        });
        proc.stdin?.end(pcm);
    });
}

/** A short rising "listening" beep (mono 16-bit @ 16 kHz), synthesised once. */
export function pling(): Buffer {
    const rate = AUDIO_SAMPLE_RATE;
    const dur = 0.18;
    const n = Math.floor(rate * dur);
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        const t = i / rate;
        const freq = 880 + (1320 - 880) * (i / n);
        const fade = Math.sin((Math.PI * i) / n);
        const val = Math.max(-32768, Math.min(32767, Math.round(32767 * 0.6 * fade * Math.sin(2 * Math.PI * freq * t))));
        buf.writeInt16LE(val, i * 2);
    }
    return buf;
}
