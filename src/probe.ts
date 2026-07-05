/**
 * Wake-word probe: open the microphone for a few seconds and report whether the wake word was
 * detected and the peak score/level seen. Used by the adapter's "Test wake word" button so users can
 * verify detection from the GUI — works even before the satellite is fully configured (no server needed).
 */
import { ensureModels } from './models';
import { WakeWord } from './wakeword';
import { Mic, resolveBackend } from './audio';
import { rms } from './vad';
import type { SatelliteConfig } from './config';
import type { Logger } from './index';

const FRAME_BYTES = 1280 * 2; // 80 ms @ 16 kHz mono 16-bit

export interface WakeProbeResult {
    detected: boolean;
    peakScore: number;
    peakRms: number;
    frames: number;
    threshold: number;
}

/**
 * Listen for `seconds` and run wake-word detection. `onProgress` is called with the running peak
 * score/RMS so the caller can show a live indicator. Resolves when the window ends.
 */
export async function probeWakeWord(
    cfg: SatelliteConfig,
    log: Logger,
    seconds: number,
    /** Called per frame with the CURRENT score/RMS and whether the wake word has fired so far. */
    onProgress?: (score: number, rms: number, detected: boolean) => void,
): Promise<WakeProbeResult> {
    const models = await ensureModels(cfg.modelsDir, cfg.wakewordModel, log);
    const wakeword = new WakeWord(models, cfg.wakewordThreshold, log);
    await wakeword.load();
    const mic = new Mic(resolveBackend(cfg.audioBackend), cfg.micDevice, log);

    let remainder = Buffer.alloc(0);
    let pumping = false;
    let peakScore = 0;
    let peakRms = 0;
    let frames = 0;
    let detected = false;

    const pump = async (): Promise<void> => {
        if (pumping) {
            return;
        }
        pumping = true;
        try {
            while (remainder.length >= FRAME_BYTES) {
                const frame = Buffer.from(remainder.subarray(0, FRAME_BYTES));
                remainder = remainder.subarray(FRAME_BYTES);
                frames++;
                const level = rms(frame);
                if (level > peakRms) {
                    peakRms = level;
                }
                const score = await wakeword.process(frame);
                const current = score ?? 0;
                if (current > peakScore) {
                    peakScore = current;
                }
                if (wakeword.triggered(score)) {
                    detected = true;
                }
                onProgress?.(current, level, detected); // current frame values for a live meter
            }
        } finally {
            pumping = false;
        }
    };

    mic.start(d => {
        remainder = Buffer.concat([remainder, d]);
        void pump();
    });
    await new Promise<void>(res => setTimeout(res, Math.max(1, seconds) * 1000));
    await new Promise<void>(res => setTimeout(res, 200)); // let the last frames drain
    await mic.stop();

    return { detected, peakScore, peakRms, frames, threshold: cfg.wakewordThreshold };
}
