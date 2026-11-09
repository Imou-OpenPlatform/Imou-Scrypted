import sdk, { Device, DeviceProvider, MediaObject, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { ImouClient, ListedCamera, LiveAddress } from './api/imou-client';
import { AppIdAuth, ImouApiError } from './auth/appid-auth';
import { ImouCameraDevice } from './camera';
import { createPluginLogger, normalizeLogLevel, PluginLogger } from './log';
import { DEFAULT_SERVER_REGION, normalizeServerRegion, regionHostFromSetting } from './regions';
import { createPluginSettings } from './settings';

const { deviceManager } = sdk;

export default class ImouCameraPlugin extends ScryptedDeviceBase implements DeviceProvider, Settings {
    devices = new Map<string, ImouCameraDevice>();
    private records = new Map<string, ListedCamera>();
    private liveTokens = new Map<string, string>();
    private client: ImouClient | undefined;
    private clientKey = '';
    private liveOpenInflight = new Map<string, Promise<LiveAddress>>();
    /** Prebuffer + WebRTC often call getVideoStream together; share one MediaObject / one cloud RTSP pull. */
    readonly videoStreamInflight = new Map<string, Promise<MediaObject>>();
    /** Prebuffer may call getDevice immediately after reload; wait until listCameras finishes. */
    private catalogSync: Promise<void> = Promise.resolve();
    readonly pluginLog: PluginLogger;

    settingsStorage = createPluginSettings(this);

    constructor() {
        super();
        this.pluginLog = createPluginLogger(this, () => normalizeLogLevel(this.settingsStorage.values.logLevel));
        // Avoid overlapping accessToken calls when the plugin reloads during deploy.
        this.catalogSync = new Promise<void>(resolve => {
            setTimeout(() => {
                void this.syncDevices(0).finally(() => resolve());
            }, 2000);
        });
    }

    getSettings(): Promise<Setting[]> {
        return this.settingsStorage.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.settingsStorage.putSetting(key, value);
    }

    async syncDevices(_duration: number): Promise<void> {
        const run = this.syncDevicesNow(_duration);
        this.catalogSync = run;
        return run;
    }

    private async syncDevicesNow(_duration: number) {
        const { dataCenter, appId, appSecret } = this.settingsStorage.values;
        this.pluginLog.info(`serverRegion=${normalizeServerRegion(dataCenter)} appId=${appId ? 'set' : 'empty'}`);
        if (!appId || !appSecret) {
            this.records.clear();
            await deviceManager.onDevicesChanged({ devices: [] });
            this.pluginLog.info('credentials empty');
            return;
        }
        try {
            const cameras = await this.api(String(dataCenter || DEFAULT_SERVER_REGION), String(appId), String(appSecret)).listCameras();
            this.records = new Map(cameras.map(camera => [camera.nativeId, camera]));
            const devices: Device[] = cameras.map(camera => ({
                info: {
                    model: camera.model,
                    manufacturer: camera.manufacturer,
                    serialNumber: camera.deviceId,
                    firmware: camera.firmware,
                },
                nativeId: camera.nativeId,
                name: camera.name,
                type: ScryptedDeviceType.Camera,
                interfaces: [
                    ScryptedInterface.VideoCamera,
                ],
            }));
            await deviceManager.onDevicesChanged({ devices });
            this.pluginLog.debug(`cameras=${cameras.map(camera => camera.nativeId).join(',') || '(none)'}`);
            this.pluginLog.info(`discovered ${cameras.length}`);
        }
        catch (error) {
            const host = regionHostFromSetting(dataCenter || DEFAULT_SERVER_REGION);
            this.pluginLog.error(`${errorMessage(error)} (host=${host})`);
            if (error instanceof ImouApiError && error.code === 'timeout') {
                this.pluginLog.error(
                    'accessToken timed out from the Scrypted host. If WSL probe:auth works, check Docker outbound HTTPS/DNS or click Refresh Devices.',
                );
            }
        }
    }

    async getDevice(nativeId: string) {
        await this.catalogSync;
        const record = this.records.get(nativeId);
        if (!record) {
            this.devices.delete(nativeId);
            return undefined;
        }
        const current = this.devices.get(nativeId);
        if (!current || current.record.productId !== record.productId || current.record.name !== record.name) {
            this.devices.set(nativeId, new ImouCameraDevice(this, nativeId, record));
        }
        return this.devices.get(nativeId);
    }

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        await this.closeLive(nativeId);
        this.devices.delete(nativeId);
    }

    /** 每次 getVideoStream 只向 Imou 要一条 RTSP URL；并发调用共用同一次 openLive，避免 Prebuffer 重试叠 API。 */
    async openLive(nativeId: string, camera: ListedCamera, streamId: number): Promise<LiveAddress> {
        const inflightKey = `${nativeId}:${streamId}`;
        const existing = this.liveOpenInflight.get(inflightKey);
        if (existing) {
            return existing;
        }
        const run = this.openLiveNow(nativeId, camera, streamId).finally(() => {
            this.liveOpenInflight.delete(inflightKey);
        });
        this.liveOpenInflight.set(inflightKey, run);
        return run;
    }

    private async openLiveNow(nativeId: string, camera: ListedCamera, streamId: number): Promise<LiveAddress> {
        const { dataCenter, appId, appSecret } = this.settingsStorage.values;
        if (!appId || !appSecret) {
            throw new ImouApiError('credentials', 'AppId or AppSecret is empty');
        }
        try {
            const client = this.api(String(dataCenter || DEFAULT_SERVER_REGION), String(appId), String(appSecret));
            await this.closeLive(nativeId);
            const live = await client.openLive(camera, streamId);
            const host = new URL(live.url).host;
            const eventId = new URL(live.url).searchParams.get('eventLiveID') || '';
            this.pluginLog.info(
                `live nativeId=${nativeId} streamId=${streamId} protocol=rtsp host=${host} eventLiveID=${eventId.slice(0, 8)}`,
            );
            return live;
        }
        catch (error) {
            if (error instanceof ImouApiError && error.code === 'FL1005') {
                this.pluginLog.error(
                    'live quota FL1005: Open Platform developer flow is insufficient; top up or wait for quota reset before preview',
                );
            }
            this.pluginLog.error(`live nativeId=${nativeId} streamId=${streamId} ${errorMessage(error)}`);
            throw error;
        }
    }

    private api(dataCenter: string, appId: string, appSecret: string): ImouClient {
        const key = `${dataCenter}\n${appId}\n${appSecret}`;
        if (!this.client || this.clientKey !== key) {
            this.client = new ImouClient(
                new AppIdAuth(appId, appSecret, dataCenter),
                line => this.pluginLog.debug(line),
            );
            this.clientKey = key;
        }
        return this.client;
    }

    private async closeLive(nativeId: string) {
        const liveToken = this.liveTokens.get(nativeId);
        if (!liveToken || !this.client) {
            this.liveTokens.delete(nativeId);
            return;
        }
        this.liveTokens.delete(nativeId);
        try {
            await this.client.closeLive(liveToken);
        }
        catch (error) {
            this.pluginLog.error(`live nativeId=${nativeId} unbind ${errorMessage(error)}`);
        }
    }
}

function errorMessage(error: unknown): string {
    if (error instanceof ImouApiError) {
        return error.message;
    }
    return error instanceof Error ? error.message : String(error);
}
