/**
 * Audio I/O with two backends:
 *   - 'alsa'  : spawn `arecord`/`aplay` — robust on a Pi, no native build (Linux only).
 *   - 'ffmpeg': spawn `ffmpeg`/`ffplay` — cross-platform (Windows / macOS / Linux).
 *
 * Capture is always 16 kHz mono 16-bit; use a `plughw:CARD,DEV` device (ALSA) so it resamples.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { AUDIO_SAMPLE_RATE } from './protocol';
import type { Logger } from './index';

export type AudioBackend = 'alsa' | 'ffmpeg';

/** Resolve 'auto' → alsa on Linux, ffmpeg elsewhere. */
export function resolveBackend(pref: string): AudioBackend {
    if (pref === 'alsa' || pref === 'ffmpeg') {
        return pref;
    }
    return process.platform === 'linux' ? 'alsa' : 'ffmpeg';
}

/** ffmpeg capture input args per platform (device = dshow name / avfoundation index / ALSA name). */
export function ffmpegInput(device: string): string[] {
    if (process.platform === 'win32') {
        return ['-f', 'dshow', '-i', `audio=${device || 'default'}`];
    }
    if (process.platform === 'darwin') {
        return ['-f', 'avfoundation', '-i', `:${device || '0'}`];
    }
    return ['-f', 'alsa', '-i', device || 'default'];
}

/** Continuous microphone capture at 16 kHz mono 16-bit; emits raw PCM chunks. */
export class Mic {
    private proc: ChildProcess | null = null;

    constructor(
        private readonly backend: AudioBackend,
        private readonly device: string,
        private readonly log: Logger,
    ) {}

    start(onData: (pcm: Buffer) => void): void {
        const [cmd, args] =
            this.backend === 'ffmpeg'
                ? ([
                      'ffmpeg',
                      [
                          '-hide_banner',
                          '-loglevel',
                          'error',
                          ...ffmpegInput(this.device),
                          '-ac',
                          '1',
                          '-ar',
                          String(AUDIO_SAMPLE_RATE),
                          '-f',
                          's16le',
                          '-',
                      ],
                  ] as const)
                : ([
                      'arecord',
                      [
                          '-q',
                          '-t',
                          'raw',
                          '-f',
                          'S16_LE',
                          '-c',
                          '1',
                          '-r',
                          String(AUDIO_SAMPLE_RATE),
                          ...(this.device && this.device !== 'default' ? ['-D', this.device] : []),
                      ],
                  ] as const);

        this.proc = spawn(cmd, args);
        this.proc.stdout?.on('data', (d: Buffer) => onData(d));
        this.proc.stderr?.on('data', (d: Buffer) => this.log.debug(`${cmd}: ${d.toString().trim()}`));
        this.proc.on('error', e =>
            this.log.error(
                `${cmd} failed: ${e.message} — is it installed? ${this.backend === 'ffmpeg' ? '(install ffmpeg)' : '(sudo apt install alsa-utils)'}`,
            ),
        );
        this.log.info(
            `Microphone capture started (${this.backend}: ${this.device || 'default'} @ ${AUDIO_SAMPLE_RATE} Hz).`,
        );
    }

    stop(): void {
        this.proc?.kill();
        this.proc = null;
    }
}

/** Play raw mono 16-bit PCM at the given rate; resolves when playback finishes. */
export function playPcm(
    pcm: Buffer,
    sampleRate: number,
    backend: AudioBackend,
    device: string,
    log: Logger,
): Promise<void> {
    return new Promise<void>(resolve => {
        const [cmd, args] =
            backend === 'ffmpeg'
                ? ([
                      'ffplay',
                      [
                          '-hide_banner',
                          '-loglevel',
                          'error',
                          '-nodisp',
                          '-autoexit',
                          '-f',
                          's16le',
                          '-ar',
                          String(sampleRate),
                          '-ch_layout',
                          'mono',
                          '-i',
                          '-',
                      ],
                  ] as const)
                : ([
                      'aplay',
                      [
                          '-q',
                          '-t',
                          'raw',
                          '-f',
                          'S16_LE',
                          '-c',
                          '1',
                          '-r',
                          String(sampleRate),
                          ...(device && device !== 'default' ? ['-D', device] : []),
                      ],
                  ] as const);

        const proc = spawn(cmd, args);
        proc.on('close', () => resolve());
        proc.on('error', e => {
            log.error(`${cmd} failed: ${e.message}`);
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
        const val = Math.max(
            -32768,
            Math.min(32767, Math.round(32767 * 0.6 * fade * Math.sin(2 * Math.PI * freq * t))),
        );
        buf.writeInt16LE(val, i * 2);
    }
    return buf;
}
