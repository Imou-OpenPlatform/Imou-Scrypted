import sdk, { FFmpegInput, MediaObject, RequestMediaStreamOptions, ResponseMediaStreamOptions, ScryptedDeviceBase, VideoCamera } from '@scrypted/sdk';
import type ImouCameraPlugin from './provider';
import type { ListedCamera, LiveAddress } from './api/imou-client';

const { mediaManager } = sdk;

const OUTPUT_FPS = 15;

/**
 * Imou cloud H.264 copy leaves long GOP + 90k tbr; Rebroadcast prebuffer often misses IDR
 * ("Unable to find sync frame"). Re-encode to short-GOP Baseline so the local RTSP ring
 * always has sync frames for WebRTC (lighter than when source was HEVC).
 */
const rebroadcastH264Arguments = [
    '-map', '0:v:0',
    '-vf', 'fps=15,scale=min(1280\\,iw):-2,format=yuv420p',
    '-r', '15',
    '-fps_mode', 'cfr',
    '-vcodec', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-bf', '0',
    '-g', '15',
    '-keyint_min', '1',
    '-sc_threshold', '0',
    '-force_key_frames', 'expr:eq(n,0)+gte(t,n_forced*1)',
    '-x264-params', 'repeat-headers=1:open_gop=0:keyint=15:min-keyint=15:scenecut=0',
];

export class ImouCameraDevice extends ScryptedDeviceBase implements VideoCamera {
    constructor(public plugin: ImouCameraPlugin, nativeId: string, public record: ListedCamera) {
        super(nativeId);
    }

    async getVideoStream(_options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const inflightKey = `${this.nativeId}:main`;
        const existing = this.plugin.videoStreamInflight.get(inflightKey);
        if (existing) {
            this.plugin.pluginLog.debug(`getVideoStream join inflight ${inflightKey}`);
            return existing;
        }
        const run = this.buildVideoStream().finally(() => {
            this.plugin.videoStreamInflight.delete(inflightKey);
        });
        this.plugin.videoStreamInflight.set(inflightKey, run);
        return run;
    }

    private async buildVideoStream(): Promise<MediaObject> {
        const live = await this.plugin.openLive(this.nativeId, this.record, 0);
        return this.createFfmpegInput(live);
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return [{
            id: 'main',
            name: 'Main',
            video: {
                codec: 'h264',
                fps: OUTPUT_FPS,
            },
        }];
    }

    private async createFfmpegInput(live: LiveAddress): Promise<MediaObject> {
        const inputArguments = [
            '-fflags', '+genpts+discardcorrupt+nobuffer',
            '-flags', 'low_delay',
            '-avoid_negative_ts', 'make_zero',
            '-max_interleave_delta', '100000000',
            '-analyzeduration', '5000000',
            '-probesize', '5000000',
            '-i', live.url,
        ];
        if (live.protocol === 'rtsp') {
            inputArguments.unshift(
                '-rtsp_transport', 'tcp',
                '-rtsp_flags', 'prefer_tcp',
                '-allowed_media_types', 'video',
                '-err_detect', 'ignore_err',
            );
        }
        else {
            inputArguments.unshift(
                '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
                '-live_start_index', '-3',
                '-err_detect', 'ignore_err',
            );
        }

        const ffmpegInput: FFmpegInput = {
            url: live.url,
            inputArguments,
            h264EncoderArguments: live.protocol === 'rtsp' ? rebroadcastH264Arguments : undefined,
            mediaStreamOptions: {
                id: 'main',
                tool: 'ffmpeg',
                prebuffer: 12_000,
                prebufferBytes: 6 * 1024 * 1024,
                video: {
                    codec: 'h264',
                    fps: OUTPUT_FPS,
                },
            },
        };

        const expireAt = streamExpireAtMs(live.url);
        if (expireAt && expireAt > Date.now() + 120_000) {
            ffmpegInput.mediaStreamOptions!.refreshAt = expireAt;
        }

        const mode = live.protocol === 'rtsp' ? 'h264 720p15 short-GOP for prebuffer' : 'hls passthrough';
        this.plugin.pluginLog.info(`video stream ${live.protocol} ${mode}`);
        return await mediaManager.createFFmpegMediaObject(ffmpegInput);
    }
}

/** Absolute epoch ms when the signed URL stops working (Rebroadcast subtracts 30s itself). */
function streamExpireAtMs(url: string): number | undefined {
    try {
        const expire = Number(new URL(url).searchParams.get('expire'));
        if (!Number.isFinite(expire) || expire <= 0) {
            return undefined;
        }
        return expire * 1000;
    }
    catch {
        return undefined;
    }
}
