/**
 * \@iobroker/assistant-satellite — public API.
 *
 * The Satellite is dependency-injected with a host (logger + status callback) so the same code runs
 * standalone (CLI) and, later, inside an ioBroker adapter wrapper — with no ioBroker dependency here.
 */
import type { SatelliteState } from './protocol';

export interface Logger {
    info(m: string): void;
    warn(m: string): void;
    error(m: string): void;
    debug(m: string): void;
}

export interface SatelliteHost {
    log: Logger;
    /** Called on every state transition (idle/listening/processing/speaking). */
    onStatus?(state: SatelliteState): void;
    /** Called when the adapter changed the playback volume (0–100), e.g. by voice ("lauter"). */
    onVolume?(level: number): void | Promise<void>;
    /**
     * The host applies the volume to a hardware mixer in `onVolume`, so the satellite plays at full scale.
     * Without it the satellite scales the audio it plays in software.
     */
    mixerVolume?: boolean;
}

export { Satellite } from './satellite';
export { LocalListener, type LocalListenerHost } from './localListener';
export { loadConfig, DEFAULT_CONFIG, parseWakewords, type SatelliteConfig } from './config';
export { probeWakeWord, type WakeProbeResult } from './probe';
export type { SatelliteState } from './protocol';
