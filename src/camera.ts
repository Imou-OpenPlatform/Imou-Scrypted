import sdk, { FFmpegInput, MediaObject, RequestMediaStreamOptions, ResponseMediaStreamOptions, ScryptedDeviceBase, VideoCamera } from '@scrypted/sdk';
import type ImouCameraPlugin from './provider';
import type { ListedCamera, LiveAddress } from './api/imou-client';
import { refreshBeforeExpire } from './live-url';

const { mediaManager } = sdk;

const OUTPUT_FPS = 15;

const rebroadcastH264Arguments = [
    '-map', '0:v:0',
    '-map', '0:a:0?',
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
            audio: {},
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
        inputArguments.unshift(
            '-rtsp_transport', 'tcp',
            '-rtsp_flags', 'prefer_tcp',
            '-err_detect', 'ignore_err',
        );

        const ffmpegInput: FFmpegInput = {
            url: live.url,
            inputArguments,
            h264EncoderArguments: rebroadcastH264Arguments,
            mediaStreamOptions: {
                id: 'main',
                tool: 'ffmpeg',
                prebuffer: 12_000,
                prebufferBytes: 6 * 1024 * 1024,
                video: {
                    codec: 'h264',
                    fps: OUTPUT_FPS,
                },
                audio: {},
            },
        };

        const refreshAt = refreshBeforeExpire(live.url);
        if (refreshAt !== undefined) {
            ffmpegInput.mediaStreamOptions!.refreshAt = Math.max(refreshAt, Date.now() + 5_000);
        }

        this.plugin.pluginLog.info('video stream rtsp h264 720p15 short-GOP for prebuffer + audio copy when present');
        return await mediaManager.createFFmpegMediaObject(ffmpegInput);
    }
}
