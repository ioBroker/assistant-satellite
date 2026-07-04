/** Simple RMS-energy voice-activity detection (ported from the Hannah satellite). */

/** RMS energy (0..32768) of a 16-bit signed LE PCM frame. */
export function rms(pcm: Buffer): number {
    const n = Math.floor(pcm.length / 2);
    if (!n) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const s = pcm.readInt16LE(i * 2);
        sum += s * s;
    }
    return Math.sqrt(sum / n);
}

/**
 * Tracks trailing silence across frames to decide when an utterance ends.
 * Silence detection only kicks in after `minFrames` (so a short pause at the very start
 * does not cut speech off).
 */
export class SilenceDetector {
    private silentFrames = 0;
    private recordedFrames = 0;

    constructor(
        private readonly threshold: number,
        private readonly silenceFrames: number,
        private readonly minFrames: number,
        private readonly maxFrames: number,
    ) {}

    /** Feed one frame; returns true when recording should stop (silence reached or max length). */
    push(pcm: Buffer): boolean {
        this.recordedFrames++;
        if (this.recordedFrames >= this.maxFrames) {
            return true;
        }
        if (this.recordedFrames < this.minFrames) {
            return false;
        }
        if (rms(pcm) < this.threshold) {
            this.silentFrames++;
            return this.silentFrames >= this.silenceFrames;
        }
        this.silentFrames = 0;
        return false;
    }
}
