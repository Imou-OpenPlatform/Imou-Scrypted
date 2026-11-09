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

    /** 常规运行：发现设备、凭证状态等。info / debug 都会输出。 */
    info(message: string) {
        this.console.log(message);
    }

    /** 排障：拉流、转码、探测编码等。仅 debug 输出。 */
    debug(message: string) {
        if (this.level() === 'debug') {
            this.console.log(message);
        }
    }
}

export function createPluginLogger(device: ScryptedDeviceBase, level: () => PluginLogLevel): PluginLogger {
    return new PluginLogger(device.console, level);
}
