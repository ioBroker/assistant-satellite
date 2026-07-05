/**
 * OpenWakeWord inference in Node via onnxruntime-node.
 *
 * Pipeline (streaming): 16 kHz mono int16 audio → melspectrogram model → sliding embedding model
 * (Google speech embeddings) → wake-word classifier → score in [0,1].
 *
 * Shapes follow the openWakeWord models:
 *   melspec:   in  [1, samples] (int16 values as float32) → out [1,1,F,32]; then mel = mel/10 + 2
 *   embedding: in  [1,76,32,1]  → out [1,1,1,96]; window of 76 mel frames, hop 8
 *   wakeword:  in  [1,16,96]    → out [1,1]     ; last 16 embeddings
 *
 * ⚠️ The exact frame counts (mel frames per chunk, warm-up) can vary by model version — validate the
 * detection threshold on the target device and adjust `wakewordThreshold`.
 */
import * as ort from 'onnxruntime-node';
import type { ModelPaths } from './models';
import type { Logger } from './index';

const MEL_BINS = 32;
const EMB_WINDOW = 76; // mel frames per embedding
const EMB_HOP = 8; // mel frames advanced per embedding
const WW_FRAMES = 16; // embeddings per wake-word inference
const EMB_DIM = 96;

export class WakeWord {
    private melspec!: ort.InferenceSession;
    private embedding!: ort.InferenceSession;
    private classifier!: ort.InferenceSession;

    private melBuffer: number[][] = []; // rows of 32 mel bins
    private melProcessed = 0; // mel frames already turned into embeddings
    private embBuffer: number[][] = []; // rows of 96 embedding dims
    private melShapeLogged = false;
    private embShapeLogged = false;

    constructor(
        private readonly models: ModelPaths,
        private readonly threshold: number,
        private readonly log: Logger,
    ) {}

    async load(): Promise<void> {
        this.melspec = await ort.InferenceSession.create(this.models.melspec);
        this.embedding = await ort.InferenceSession.create(this.models.embedding);
        this.classifier = await ort.InferenceSession.create(this.models.wakeword);
        this.log.info('Wake-word models loaded.');
        this.log.info(
            `  melspec   IO: in=[${this.melspec.inputNames.join(', ')}] out=[${this.melspec.outputNames.join(', ')}]`,
        );
        this.log.info(
            `  embedding IO: in=[${this.embedding.inputNames.join(', ')}] out=[${this.embedding.outputNames.join(', ')}]`,
        );
        this.log.info(
            `  classifier IO: in=[${this.classifier.inputNames.join(', ')}] out=[${this.classifier.outputNames.join(', ')}]`,
        );
    }

    /** Reset the streaming buffers (call after a detection so it re-arms cleanly). */
    reset(): void {
        this.melBuffer = [];
        this.melProcessed = 0;
        this.embBuffer = [];
    }

    /**
     * Feed one audio chunk (16-bit signed LE PCM, ideally ~1280 samples = 80 ms) and return the
     * current wake-word score, or null if not enough context yet.
     */
    async process(pcm: Buffer): Promise<number | null> {
        await this.appendMel(pcm);
        await this.appendEmbeddings();
        if (this.embBuffer.length < WW_FRAMES) {
            return null;
        }
        return this.classify();
    }

    /** True when the given score crosses the configured detection threshold. */
    triggered(score: number | null): boolean {
        return score !== null && score >= this.threshold;
    }

    private async appendMel(pcm: Buffer): Promise<void> {
        const n = Math.floor(pcm.length / 2);
        const audio = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            audio[i] = pcm.readInt16LE(i * 2); // int16 value as float (openWakeWord convention)
        }
        const inName = this.melspec.inputNames[0];
        const outName = this.melspec.outputNames[0];
        const out = await this.melspec.run({ [inName]: new ort.Tensor('float32', audio, [1, n]) });
        const t = out[outName];
        const data = t.data as Float32Array;
        if (!this.melShapeLogged) {
            this.log.info(`melspec output dims for ${n} samples: [${t.dims.join(',')}] (expected [1,1,F,32])`);
            this.melShapeLogged = true;
        }
        // dims [1,1,F,32]
        const frames = Number(t.dims[2]);
        for (let f = 0; f < frames; f++) {
            const row = new Array<number>(MEL_BINS);
            for (let b = 0; b < MEL_BINS; b++) {
                row[b] = data[f * MEL_BINS + b] / 10 + 2; // openWakeWord mel transform
            }
            this.melBuffer.push(row);
        }
    }

    private async appendEmbeddings(): Promise<void> {
        const inName = this.embedding.inputNames[0];
        const outName = this.embedding.outputNames[0];
        while (this.melProcessed + EMB_WINDOW <= this.melBuffer.length) {
            const flat = new Float32Array(EMB_WINDOW * MEL_BINS);
            for (let f = 0; f < EMB_WINDOW; f++) {
                const row = this.melBuffer[this.melProcessed + f];
                for (let b = 0; b < MEL_BINS; b++) {
                    flat[f * MEL_BINS + b] = row[b];
                }
            }
            const out = await this.embedding.run({
                [inName]: new ort.Tensor('float32', flat, [1, EMB_WINDOW, MEL_BINS, 1]),
            });
            if (!this.embShapeLogged) {
                this.log.info(`embedding output dims: [${out[outName].dims.join(',')}] (expected [1,1,1,96])`);
                this.embShapeLogged = true;
            }
            const emb = out[outName].data as Float32Array; // [1,1,1,96]
            this.embBuffer.push(Array.from(emb.slice(0, EMB_DIM)));
            this.melProcessed += EMB_HOP;
        }
        // Trim consumed mel frames to keep memory bounded.
        if (this.melProcessed > EMB_WINDOW) {
            const drop = this.melProcessed - EMB_WINDOW;
            this.melBuffer.splice(0, drop);
            this.melProcessed -= drop;
        }
        if (this.embBuffer.length > WW_FRAMES * 4) {
            this.embBuffer.splice(0, this.embBuffer.length - WW_FRAMES * 4);
        }
    }

    private async classify(): Promise<number> {
        const inName = this.classifier.inputNames[0];
        const outName = this.classifier.outputNames[0];
        const window = this.embBuffer.slice(-WW_FRAMES);
        const flat = new Float32Array(WW_FRAMES * EMB_DIM);
        for (let f = 0; f < WW_FRAMES; f++) {
            for (let d = 0; d < EMB_DIM; d++) {
                flat[f * EMB_DIM + d] = window[f][d];
            }
        }
        const out = await this.classifier.run({
            [inName]: new ort.Tensor('float32', flat, [1, WW_FRAMES, EMB_DIM]),
        });
        return (out[outName].data as Float32Array)[0];
    }
}
