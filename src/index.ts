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
}

export { Satellite } from './satellite';
export { LocalListener, type LocalListenerHost } from './localListener';
export { loadConfig, DEFAULT_CONFIG, parseWakewords, type SatelliteConfig } from './config';
export { probeWakeWord, type WakeProbeResult } from './probe';
export type { SatelliteState } from './protocol';
