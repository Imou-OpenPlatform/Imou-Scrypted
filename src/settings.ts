import { ScryptedDeviceBase } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { DEFAULT_SERVER_REGION, SERVER_REGION_CHOICES } from './regions';

export type PreviewProtocolSetting = 'RTSP' | 'HLS';

export interface PluginSettingsOwner {
    syncDevices(duration: number): Promise<void>;
}

export function normalizePreviewProtocol(value: unknown): PreviewProtocolSetting {
    if (String(value).toUpperCase() === 'HLS') {
        return 'HLS';
    }
    return 'RTSP';
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
        previewProtocol: {
            title: 'Cloud Preview Protocol',
            description: 'RTSP (getStreamUrl) often starts preview faster. HLS (bindDeviceLive) is more refresh-friendly but the cloud playlist may lag ~10s and Scrypted adds a few seconds when Main prebuffer is off.',
            choices: ['RTSP', 'HLS'],
            defaultValue: 'HLS',
        },
        logLevel: {
            title: 'Log Level',
            description: 'Info: discovery and errors only. Debug: also logs live URLs, transcode, and codec probe details (no secrets).',
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
    });
}
