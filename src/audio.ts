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
    /** Set by stop() so the expected exit isn't reported as an error. */
    private stopping = false;
    /** Last stderr line from the capture process (surfaced if it dies unexpectedly). */
    private lastErr = '';

    constructor(
        private readonly backend: AudioBackend,
        private readonly device: string,
        private readonly log: Logger,
    ) {}

    start(onData: (pcm: Buffer) => void): void {
        this.stopping = false;
        this.lastErr = '';
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
        this.proc.stderr?.on('data', (d: Buffer) => {
            this.lastErr = d.toString().trim();
            this.log.debug(`${cmd}: ${this.lastErr}`);
        });
        this.proc.on('error', e =>
            this.log.error(
                `${cmd} failed: ${e.message} — is it installed? ${this.backend === 'ffmpeg' ? '(install ffmpeg)' : '(sudo apt install alsa-utils)'}`,
            ),
        );
        // A healthy capture runs until stop(); an early exit means the device could not be opened.
        this.proc.on('close', code => {
            if (this.stopping) {
                return;
            }
            const hint =
                this.backend === 'alsa'
                    ? " Pick a real capture device — run 'arecord -l' and set micDevice to e.g. 'plughw:1,0'. The ALSA 'default' device often has no capture slave."
                    : ' Check the microphone device / that ffmpeg can open it.';
            this.log.warn(
                `Microphone capture stopped unexpectedly (${cmd} exit ${code ?? '?'}).${this.lastErr ? ` Last error: ${this.lastErr}.` : ''}${hint}`,
            );
        });
        this.log.info(
            `Microphone capture started (${this.backend}: ${this.device || 'default'} @ ${AUDIO_SAMPLE_RATE} Hz).`,
        );
    }

    /** Stop capture and wait for the process to actually exit so ALSA/the device is released. */
    async stop(): Promise<void> {
        this.stopping = true;
        const proc = this.proc;
        this.proc = null;
        if (!proc) {
            return;
        }
        await new Promise<void>(resolve => {
            let done = false;
            const finish = (): void => {
                if (!done) {
                    done = true;
                    resolve();
                }
            };
            proc.once('close', finish);
            proc.kill(); // SIGTERM
            // Safety net: force-kill if it does not exit promptly, then resolve anyway.
            setTimeout(() => {
                if (!done) {
                    try {
                        proc.kill('SIGKILL');
                    } catch {
                        /* already gone */
                    }
                    finish();
                }
            }, 1500);
        });
    }
}

/**
 * Play raw mono 16-bit PCM at the given rate. Returns the child process (so playback can be cancelled
 * for barge-in) and a `done` promise that resolves when playback finishes or is killed.
 */
export function playPcm(
    pcm: Buffer,
    sampleRate: number,
    backend: AudioBackend,
    device: string,
    log: Logger,
): { proc: ChildProcess; done: Promise<void> } {
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
    const done = new Promise<void>(resolve => {
        proc.on('close', () => resolve());
        proc.on('error', e => {
            log.error(`${cmd} failed: ${e.message}`);
            resolve();
        });
    });
    proc.stdin?.end(pcm);
    return { proc, done };
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
