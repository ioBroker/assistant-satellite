/** Satellite configuration (loaded from config.json / CLI). */
export interface SatelliteConfig {
    /** Log verbosity. 'debug' also prints the wake-word/mic diagnostics. */
    logLevel: 'info' | 'debug';

    /** Device identity reported to the adapter. */
    device: string;
    room: string;

    /** Adapter (voice-server) address. Discovery via MQTT is optional; a fixed host needs no broker. */
    host: string;
    port: number;
    /** UDP port the satellite listens on for TTS/control from the adapter. */
    listenPort: number;

    /** Optional MQTT discovery — leave broker empty to run without a broker (fixed host only). */
    mqttBroker: string;
    mqttPort: number;
    mqttUser: string;
    mqttPass: string;
    discoveryTopic: string;
    discoveryTimeoutMs: number;

    /** Audio backend: 'auto' (alsa on Linux, ffmpeg elsewhere), or force 'alsa' / 'ffmpeg'. */
    audioBackend: 'auto' | 'alsa' | 'ffmpeg';
    /**
     * Capture/playback devices. ALSA: e.g. "plughw:2,0". ffmpeg mic: dshow device name (Windows),
     * avfoundation index (macOS). "default" or "" = system default.
     */
    micDevice: string;
    speakerDevice: string;

    /** Wake word. modelPath: path to a wakeword .onnx ('' = built-in "hey_jarvis"). */
    wakewordModel: string;
    wakewordThreshold: number;
    /** Directory the melspectrogram/embedding/wakeword models are downloaded to/read from. */
    modelsDir: string;

    /** Recording (VAD) — silence detection to end an utterance. */
    silenceThreshold: number;
    silenceMs: number;
    minRecordMs: number;
    maxRecordMs: number;
    /** Number of pre-wake 80 ms chunks prepended to the recording (so no speech is lost). */
    preBufferChunks: number;

    /** Heartbeat / registration. */
    registrationTimeoutMs: number;
    heartbeatIntervalMs: number;
}

export const DEFAULT_CONFIG: SatelliteConfig = {
    logLevel: 'info',
    device: 'satellite',
    room: '',
    host: '',
    port: 7775,
    listenPort: 7776,
    mqttBroker: '',
    mqttPort: 1883,
    mqttUser: '',
    mqttPass: '',
    discoveryTopic: 'hannah/server',
    discoveryTimeoutMs: 5000,
    audioBackend: 'auto',
    micDevice: 'default',
    speakerDevice: 'default',
    wakewordModel: '',
    wakewordThreshold: 0.5,
    modelsDir: 'models',
    silenceThreshold: 300,
    silenceMs: 800,
    minRecordMs: 800,
    maxRecordMs: 8000,
    preBufferChunks: 5,
    registrationTimeoutMs: 5000,
    heartbeatIntervalMs: 10000,
};

/** Merge a partial config (from config.json) onto the defaults. */
export function loadConfig(partial: Partial<SatelliteConfig>): SatelliteConfig {
    return { ...DEFAULT_CONFIG, ...partial };
}
