/**
 * Preflight checks: run before installing the service (and via the `check` subcommand) to verify
 * everything is present — Node, systemd, root rights, audio tools, and functional mic-in / speaker-out.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { ffmpegInput, type AudioBackend } from './audio';
import type { SatelliteConfig } from './config';
import type { Logger } from './index';

export type CheckStatus = 'ok' | 'warn' | 'fail';
export interface CheckResult {
    name: string;
    status: CheckStatus;
    detail: string;
}

const ok = (name: string, detail = ''): CheckResult => ({ name, status: 'ok', detail });
const warn = (name: string, detail: string): CheckResult => ({ name, status: 'warn', detail });
const fail = (name: string, detail: string): CheckResult => ({ name, status: 'fail', detail });

function which(cmd: string): boolean {
    try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const firstLine = (s: string): string => s.split('\n')[0].slice(0, 140);

/** Capture ~1 s from the mic and confirm real bytes come out. */
function checkCapture(cfg: SatelliteConfig, backend: AudioBackend): CheckResult {
    try {
        let out: Buffer;
        if (backend === 'ffmpeg') {
            out = execFileSync(
                'ffmpeg',
                ['-hide_banner', '-loglevel', 'error', ...ffmpegInput(cfg.micDevice), '-t', '1', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
                { timeout: 8000, maxBuffer: 1 << 22 },
            );
        } else {
            const args = ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-d', '1', '-t', 'raw'];
            if (cfg.micDevice && cfg.micDevice !== 'default') {
                args.push('-D', cfg.micDevice);
            }
            out = execFileSync('arecord', args, { timeout: 8000, maxBuffer: 1 << 22 });
        }
        return out.length > 1000
            ? ok('audio:in', `captured ${out.length} bytes from '${cfg.micDevice}'`)
            : fail('audio:in', `captured only ${out.length} bytes — wrong device or no signal`);
    } catch (e) {
        return fail('audio:in', `capture failed (device busy/wrong?): ${firstLine((e as Error).message)}`);
    }
}

/** Play 0.2 s of silence to confirm the output device opens. */
function checkPlayback(cfg: SatelliteConfig, backend: AudioBackend): CheckResult {
    const silence = Buffer.alloc(Math.round((16000 * 2) / 5)); // 0.2 s @ 16 kHz mono 16-bit
    try {
        if (backend === 'ffmpeg') {
            execFileSync(
                'ffplay',
                ['-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit', '-f', 's16le', '-ar', '16000', '-ch_layout', 'mono', '-i', '-'],
                { input: silence, timeout: 8000 },
            );
        } else {
            const args = ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1'];
            if (cfg.speakerDevice && cfg.speakerDevice !== 'default') {
                args.push('-D', cfg.speakerDevice);
            }
            execFileSync('aplay', args, { input: silence, timeout: 8000 });
        }
        return ok('audio:out', `output device '${cfg.speakerDevice}' opened`);
    } catch (e) {
        return fail('audio:out', `playback failed (device busy/wrong?): ${firstLine((e as Error).message)}`);
    }
}

/** Run all checks. `forService` adds the systemd/root prerequisites. */
export function runChecks(cfg: SatelliteConfig, backend: AudioBackend, forService: boolean): CheckResult[] {
    const results: CheckResult[] = [];

    const major = Number(process.versions.node.split('.')[0]);
    results.push(major >= 18 ? ok('node', `v${process.versions.node}`) : fail('node', `v${process.versions.node} (need ≥ 18)`));

    if (forService) {
        results.push(
            process.platform === 'linux'
                ? ok('platform', 'linux')
                : fail('platform', `${process.platform} — systemd install is Linux-only`),
        );
        results.push(which('systemctl') ? ok('systemctl', 'found') : fail('systemctl', 'not found'));
        const root = typeof process.getuid === 'function' && process.getuid() === 0;
        results.push(root ? ok('root', 'running as root') : warn('root', 'not root — run install with sudo'));
    }

    for (const t of backend === 'ffmpeg' ? ['ffmpeg', 'ffplay'] : ['arecord', 'aplay']) {
        results.push(
            which(t)
                ? ok(`tool:${t}`, 'found')
                : fail(`tool:${t}`, `not found — install ${backend === 'ffmpeg' ? 'ffmpeg' : 'alsa-utils'}`),
        );
    }

    results.push(checkCapture(cfg, backend));
    results.push(checkPlayback(cfg, backend));

    results.push(
        cfg.host
            ? ok('config:server', `host ${cfg.host}:${cfg.port}`)
            : fail('config:server', 'set "host" so the satellite can reach the adapter'),
    );

    try {
        fs.mkdirSync(cfg.modelsDir, { recursive: true });
        fs.accessSync(cfg.modelsDir, fs.constants.W_OK);
        results.push(ok('models', `'${cfg.modelsDir}' writable`));
    } catch {
        results.push(warn('models', `'${cfg.modelsDir}' not writable — model download may fail`));
    }

    return results;
}

/** Print the results; returns false if any check failed. */
export function printChecks(results: CheckResult[], log: Logger): boolean {
    const label: Record<CheckStatus, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' };
    for (const c of results) {
        const line = `[${label[c.status]}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`;
        if (c.status === 'fail') {
            log.error(line);
        } else if (c.status === 'warn') {
            log.warn(line);
        } else {
            log.info(line);
        }
    }
    return !results.some(c => c.status === 'fail');
}
