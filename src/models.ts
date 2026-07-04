/**
 * OpenWakeWord ONNX model management. The pipeline needs three models:
 *   - melspectrogram.onnx  (shared) — audio → mel spectrogram
 *   - embedding_model.onnx (shared) — mel → Google speech embeddings
 *   - <wakeword>.onnx               — embeddings → wake-word score
 *
 * Models are downloaded on first run to `modelsDir` from the openWakeWord releases.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from './index';

/** openWakeWord release assets (feature models + a few pretrained wake words). */
const RELEASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1';
export const MELSPEC_URL = `${RELEASE}/melspectrogram.onnx`;
export const EMBEDDING_URL = `${RELEASE}/embedding_model.onnx`;
/** Built-in wake words available as ONNX (name → asset). Default "hey_jarvis". */
export const WAKEWORDS: Record<string, string> = {
    hey_jarvis: `${RELEASE}/hey_jarvis_v0.1.onnx`,
    alexa: `${RELEASE}/alexa_v0.1.onnx`,
    hey_mycroft: `${RELEASE}/hey_mycroft_v0.1.onnx`,
    hey_rhasspy: `${RELEASE}/hey_rhasspy_v0.1.onnx`,
};

async function download(url: string, dest: string, log: Logger): Promise<void> {
    if (fs.existsSync(dest)) {
        return;
    }
    log.info(`Downloading model ${path.basename(dest)} …`);
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`download ${url} failed: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    log.info(`Saved ${path.basename(dest)} (${(buf.length / 1024).toFixed(0)} KB).`);
}

export interface ModelPaths {
    melspec: string;
    embedding: string;
    wakeword: string;
}

/**
 * Ensure the three model files exist locally, downloading the missing ones.
 * `wakewordModel` may be a name from WAKEWORDS, a URL, or a local .onnx path.
 */
export async function ensureModels(modelsDir: string, wakewordModel: string, log: Logger): Promise<ModelPaths> {
    const melspec = path.join(modelsDir, 'melspectrogram.onnx');
    const embedding = path.join(modelsDir, 'embedding_model.onnx');
    await download(MELSPEC_URL, melspec, log);
    await download(EMBEDDING_URL, embedding, log);

    let wakeword: string;
    const name = wakewordModel || 'hey_jarvis';
    if (fs.existsSync(name)) {
        wakeword = name; // a local file path
    } else if (/^https?:\/\//.test(name)) {
        wakeword = path.join(modelsDir, path.basename(name));
        await download(name, wakeword, log);
    } else {
        const url = WAKEWORDS[name];
        if (!url) {
            throw new Error(`unknown wake word "${name}" (known: ${Object.keys(WAKEWORDS).join(', ')})`);
        }
        wakeword = path.join(modelsDir, `${name}.onnx`);
        await download(url, wakeword, log);
    }
    return { melspec, embedding, wakeword };
}
