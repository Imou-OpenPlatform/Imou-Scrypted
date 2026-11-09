import type { ScryptedDeviceBase } from '@scrypted/sdk';

export type PluginLogLevel = 'info' | 'debug';

export function normalizeLogLevel(value: unknown): PluginLogLevel {
    return value === 'debug' ? 'debug' : 'info';
}

export class PluginLogger {
    constructor(
        private readonly console: Console,
        private readonly level: () => PluginLogLevel,
    ) {
    }

    error(message: string) {
        this.console.error(message);
    }

    info(message: string) {
        this.console.log(message);
    }

    debug(message: string) {
        if (this.level() === 'debug') {
            this.console.log(message);
        }
    }
}

export function createPluginLogger(device: ScryptedDeviceBase, level: () => PluginLogLevel): PluginLogger {
    return new PluginLogger(device.console, level);
}
