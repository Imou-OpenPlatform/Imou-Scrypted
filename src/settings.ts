import { ScryptedDeviceBase } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { DEFAULT_SERVER_REGION, SERVER_REGION_CHOICES } from './regions';

export interface PluginSettingsOwner {
    syncDevices(duration: number): Promise<void>;
}

export function createPluginSettings(plugin: PluginSettingsOwner & ScryptedDeviceBase) {
    return new StorageSettings(plugin, {
        dataCenter: {
            title: 'Server region',
            description: 'Select the server region closest to your location (same options as Imou in Home Assistant).',
            choices: [...SERVER_REGION_CHOICES],
            defaultValue: DEFAULT_SERVER_REGION,
            onPut: async () => plugin.syncDevices(0),
        },
        appId: {
            title: 'App ID',
            description: 'AppId from the Imou Open Platform application.',
            onPut: async () => plugin.syncDevices(0),
        },
        appSecret: {
            title: 'App Secret',
            description: 'AppSecret from the Imou Open Platform application.',
            type: 'password',
            onPut: async () => plugin.syncDevices(0),
        },
        logLevel: {
            title: 'Log Level',
            description: 'Info: discovery and errors only. Debug: also logs live URLs and stream setup (no secrets).',
            choices: ['info', 'debug'],
            defaultValue: 'info',
        },
        refreshDevices: {
            title: 'Refresh Devices',
            type: 'button',
            description: 'Discover cameras again from the Open Platform.',
            noStore: true,
            onPut: async () => plugin.syncDevices(0),
        },
        lastDiscoveryError: {
            title: 'Last discovery error',
            description: 'Empty when the last device refresh succeeded. The device list below may be from an earlier refresh.',
            readonly: true,
            defaultValue: '',
        },
    });
}
