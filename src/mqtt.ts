/**
 * Optional MQTT discovery — reads the adapter address from a retained topic
 * (`{ "host": "...", "port": 7775 }`). Only used when no fixed host is configured.
 */
import mqtt from 'mqtt';
import type { SatelliteConfig } from './config';
import type { Logger } from './index';

export function discoverServer(cfg: SatelliteConfig, log: Logger): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
        const client = mqtt.connect(`mqtt://${cfg.mqttBroker}:${cfg.mqttPort}`, {
            username: cfg.mqttUser || undefined,
            password: cfg.mqttPass || undefined,
            connectTimeout: cfg.discoveryTimeoutMs,
        });
        const timer = setTimeout(() => {
            client.end(true);
            reject(new Error(`MQTT discovery timed out (topic '${cfg.discoveryTopic}' on ${cfg.mqttBroker})`));
        }, cfg.discoveryTimeoutMs);

        client.on('connect', () => {
            log.info(`MQTT connected (${cfg.mqttBroker}:${cfg.mqttPort}), waiting for discovery …`);
            client.subscribe(cfg.discoveryTopic, { qos: 1 });
        });
        client.on('message', (_topic, payload) => {
            try {
                const data = JSON.parse(payload.toString()) as { host: string; port: number };
                if (data.host) {
                    clearTimeout(timer);
                    client.end();
                    resolve({ host: data.host, port: Number(data.port) || cfg.port });
                }
            } catch {
                /* ignore malformed discovery message */
            }
        });
        client.on('error', e => {
            clearTimeout(timer);
            client.end(true);
            reject(e);
        });
    });
}
