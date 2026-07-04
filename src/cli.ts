#!/usr/bin/env node
/**
 * CLI entry point:
 *   assistant-satellite [config.json]           run the satellite
 *   assistant-satellite install [config.json]   install + start a systemd service (Linux, needs sudo)
 *   assistant-satellite uninstall               stop + remove the systemd service (needs sudo)
 */
import * as fs from 'node:fs';
import { Satellite, loadConfig, DEFAULT_CONFIG, type SatelliteConfig } from './index';
import { installService, uninstallService } from './service';
import { runChecks, printChecks } from './checks';
import { resolveBackend } from './audio';

// Debug is off until we know the config's logLevel; the DEBUG env var forces it on regardless.
let debugEnabled = !!process.env.DEBUG;
const log = {
    info: (m: string): void => console.log(`[INFO]  ${m}`),
    warn: (m: string): void => console.warn(`[WARN]  ${m}`),
    error: (m: string): void => console.error(`[ERROR] ${m}`),
    debug: (m: string): void => {
        if (debugEnabled) {
            console.log(`[DEBUG] ${m}`);
        }
    },
};

const [command, ...rest] = process.argv.slice(2);
const configArg = rest.find(a => !a.startsWith('--')) || 'config.json';

// `check` — run preflight checks (rights, audio in/out, tools, config) and exit.
if (command === 'check') {
    if (!fs.existsSync(configArg)) {
        log.error(`config not found: ${configArg}`);
        process.exit(1);
    }
    try {
        const c = loadConfig(JSON.parse(fs.readFileSync(configArg, 'utf8')) as Partial<SatelliteConfig>);
        const passed = printChecks(runChecks(c, resolveBackend(c.audioBackend), true), log);
        process.exit(passed ? 0 : 1);
    } catch (e) {
        log.error((e as Error).message);
        process.exit(1);
    }
}

// Service management subcommands (Linux/systemd). `install` runs the checks first.
if (command === 'install' || command === '--install') {
    try {
        installService(configArg, log, rest.includes('--force'));
        process.exit(0);
    } catch (e) {
        log.error((e as Error).message);
        process.exit(1);
    }
}
if (command === 'uninstall' || command === '--uninstall') {
    try {
        uninstallService(log);
        process.exit(0);
    } catch (e) {
        log.error((e as Error).message);
        process.exit(1);
    }
}

const configPath = command || 'config.json';

if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 4)}\n`);
    log.info(`No config found — wrote defaults to ${configPath}.`);
    log.info('Edit it (at least set "host" and "device"), then run again.');
    process.exit(0);
}

let cfg: SatelliteConfig;
try {
    cfg = loadConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<SatelliteConfig>);
} catch (e) {
    log.error(`Cannot read ${configPath}: ${(e as Error).message}`);
    process.exit(1);
}

if (cfg.logLevel === 'debug') {
    debugEnabled = true;
}

const satellite = new Satellite(cfg, { log, onStatus: s => log.debug(`status: ${s}`) });

satellite.start().catch(e => {
    log.error((e as Error).message);
    process.exit(1);
});

let stopping = false;
async function shutdown(): Promise<void> {
    if (stopping) {
        return;
    }
    stopping = true;
    log.info('Shutting down …');
    await satellite.stop();
    process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
