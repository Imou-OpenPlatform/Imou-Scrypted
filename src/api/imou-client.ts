import { AppIdAuth, ImouApiError } from '../auth/appid-auth';

export interface ListedCamera {
    nativeId: string;
    deviceId: string;
    channelId: string;
    name: string;
    model?: string;
    manufacturer?: string;
    productId?: string;
    firmware?: string;
}

export interface LiveAddress {
    protocol: 'rtsp' | 'hls';
    url: string;
    liveToken?: string;
}

export type PreviewProtocol = 'rtsp' | 'hls';

/**
 * Device list and cloud preview URLs.
 * RTSP: getStreamUrl (Home Assistant). HLS: bindDeviceLive + getLiveStreamInfo (plan doc path).
 */
export class ImouClient {
    constructor(private readonly auth: AppIdAuth, private readonly log: (line: string) => void) {
    }

    async listCameras(): Promise<ListedCamera[]> {
        const cameras: ListedCamera[] = [];
        for (let page = 1; page <= 20; page += 1) {
            const data = await this.auth.request('/openapi/listDeviceDetailsByPage', {
                page,
                pageSize: 50,
            }, true);
            const devices = Array.isArray(data.deviceList) ? data.deviceList : [];
            for (const device of devices) {
                cameras.push(...camerasFromDevice(device));
            }
            if (devices.length < 50) {
                break;
            }
        }
        return cameras;
    }

    async openLive(camera: ListedCamera, streamId: number, protocol: PreviewProtocol): Promise<LiveAddress> {
        if (protocol === 'hls') {
            return this.openHlsLive(camera, streamId);
        }
        return this.openRtspLive(camera, streamId);
    }

    async closeLive(liveToken: string): Promise<void> {
        await this.auth.request('/openapi/unbindLive', { liveToken }, true);
    }

    private async openRtspLive(camera: ListedCamera, streamId: number): Promise<LiveAddress> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                const url = await this.rtspUrl(camera, streamId);
                return { protocol: 'rtsp', url };
            }
            catch (error) {
                lastError = error;
                this.log(
                    `getStreamUrl attempt ${attempt}/3 failed ${error instanceof Error ? error.message : error}`,
                );
                if (isNonRetryableLiveError(error)) {
                    break;
                }
                if (attempt < 3) {
                    await delay(1500 * attempt);
                }
            }
        }
        throw lastError;
    }

    private async openHlsLive(camera: ListedCamera, streamId: number): Promise<LiveAddress> {
        const params: Record<string, any> = {
            deviceId: camera.deviceId,
            channelId: camera.channelId,
            streamId,
        };
        if (camera.productId) {
            params.productId = camera.productId;
        }
        let bindData: Record<string, any> = {};
        try {
            bindData = await this.auth.request('/openapi/bindDeviceLive', params, true);
            this.log('bindDeviceLive: created');
        }
        catch (error) {
            if (error instanceof ImouApiError && error.code === 'LV1001') {
                this.log('bindDeviceLive: live already exists (LV1001)');
            }
            else {
                throw error;
            }
        }
        const info = await this.auth.request('/openapi/getLiveStreamInfo', {
            deviceId: camera.deviceId,
            channelId: camera.channelId,
        }, true);
        const stream = pickMainHls(info) ?? pickMainHls(bindData);
        const hls = stream?.hls;
        if (typeof hls !== 'string' || !hls.startsWith('http')) {
            throw new ImouApiError('no-hls', 'getLiveStreamInfo');
        }
        const liveToken = String(
            stream?.liveToken ?? info.liveToken ?? bindData.liveToken ?? '',
        ).trim() || undefined;
        return { protocol: 'hls', url: hls, liveToken };
    }

    private async rtspUrl(camera: ListedCamera, streamId: number): Promise<string> {
        const params: Record<string, any> = {
            deviceId: camera.deviceId,
            channelId: camera.channelId,
            streamId,
        };
        if (camera.productId) {
            params.productId = camera.productId;
        }
        const data = await this.auth.request('/openapi/getStreamUrl', params, true);
        const url = data.url;
        if (typeof url !== 'string' || !url.startsWith('rtsp://')) {
            throw new ImouApiError('no-url', 'getStreamUrl');
        }
        return url;
    }
}

function pickMainHls(data: Record<string, any> | undefined): Record<string, any> | undefined {
    const streams = Array.isArray(data?.streams) ? data.streams : [];
    const main = streams.filter((stream: any) => Number(stream.streamId) === 0 && stream.hls);
    const pool = main.length ? main : streams.filter((stream: any) => stream.hls);
    const on = pool.filter((stream: any) => String(stream.status) === '1');
    const candidates = on.length ? on : pool;
    return (
        candidates.find((stream: any) => String(stream.hls).startsWith('https://'))
        ?? candidates[0]
        ?? undefined
    );
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Open Platform live quota; retrying wastes calls and prebuffer restart loops. */
function isNonRetryableLiveError(error: unknown): boolean {
    return error instanceof ImouApiError && error.code === 'FL1005';
}

function camerasFromDevice(device: any): ListedCamera[] {
    const deviceId = String(device.deviceId ?? '');
    if (!deviceId) {
        return [];
    }
    const channels = Array.isArray(device.channelList) && device.channelList.length
        ? device.channelList
        : [{ channelId: '0', channelName: device.deviceName }];
    return channels.map((channel: any) => {
        const channelId = String(channel.channelId ?? '0');
        const multiple = channels.length > 1;
        return {
            nativeId: `${deviceId}:${channelId}`,
            deviceId,
            channelId,
            name: multiple ? (channel.channelName || `${device.deviceName} ${channelId}`) : (device.deviceName || deviceId),
            model: device.deviceModel,
            manufacturer: device.brand || 'Imou',
            productId: device.productId || undefined,
            firmware: device.deviceVersion,
        };
    });
}
