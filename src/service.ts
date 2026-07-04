/**
 * Self-install as a systemd service: `assistant-satellite install [config.json]`.
 * Generates /etc/systemd/system/assistant-satellite.service pointing at this node binary + cli.js +
 * the given config, then daemon-reload + enable --now. Needs root (re-run with sudo).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Logger } from './index';

const SERVICE_NAME = 'assistant-satellite';
const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;

function run(cmd: string, args: string[], log: Logger): void {
    log.debug(`$ ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, args, { stdio: 'inherit' });
}

function requireLinux(): void {
    if (process.platform !== 'linux') {
        throw new Error('Service install/uninstall is only supported on Linux (systemd).');
    }
}

export function installService(configPath: string, log: Logger): void {
    requireLinux();
    const absConfig = path.resolve(configPath);
    if (!fs.existsSync(absConfig)) {
        throw new Error(`config not found: ${absConfig} — run once to create/edit it, then install.`);
    }
    const nodeBin = process.execPath;
    const cliPath = path.join(__dirname, 'cli.js');
    const workingDir = path.dirname(absConfig);
    // Run the service as the invoking user (sudo → the real user), not root, so audio access is normal.
    const user = process.env.SUDO_USER || os.userInfo().username;

    const unit =
        `[Unit]\n` +
        `Description=ioBroker assistant satellite\n` +
        `After=network-online.target sound.target\n` +
        `Wants=network-online.target\n\n` +
        `[Service]\n` +
        `Type=simple\n` +
        `WorkingDirectory=${workingDir}\n` +
        `ExecStart=${nodeBin} ${cliPath} ${absConfig}\n` +
        `Restart=always\n` +
        `RestartSec=5\n` +
        `User=${user}\n` +
        `SupplementaryGroups=audio\n\n` +
        `[Install]\n` +
        `WantedBy=multi-user.target\n`;

    try {
        fs.writeFileSync(SERVICE_PATH, unit);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EACCES') {
            throw new Error(`cannot write ${SERVICE_PATH} — re-run with sudo.`);
        }
        throw e;
    }
    log.info(`Wrote ${SERVICE_PATH} (runs as User=${user}).`);
    run('systemctl', ['daemon-reload'], log);
    run('systemctl', ['enable', '--now', SERVICE_NAME], log);
    log.info(`Service '${SERVICE_NAME}' installed and started.`);
    log.info(`  logs:    journalctl -u ${SERVICE_NAME} -f`);
    log.info(`  restart: sudo systemctl restart ${SERVICE_NAME}`);
    log.info(`  remove:  sudo ${nodeBin} ${cliPath} uninstall`);
}

export function uninstallService(log: Logger): void {
    requireLinux();
    try {
        run('systemctl', ['disable', '--now', SERVICE_NAME], log);
    } catch {
        /* not enabled/running — ignore */
    }
    try {
        fs.unlinkSync(SERVICE_PATH);
        log.info(`Removed ${SERVICE_PATH}.`);
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EACCES') {
            throw new Error(`cannot remove ${SERVICE_PATH} — re-run with sudo.`);
        }
        if (code !== 'ENOENT') {
            throw e;
        }
    }
    run('systemctl', ['daemon-reload'], log);
    log.info(`Service '${SERVICE_NAME}' removed.`);
}
