import { spawn } from 'node:child_process';
import sdk from '@scrypted/sdk';

export type ProbedVideoCodec = 'h264' | 'hevc' | 'unknown';

export async function probeVideoCodec(
    url: string,
    protocol: 'rtsp' | 'hls',
    probeTimeoutMs = 12_000,
): Promise<ProbedVideoCodec> {
    const ffmpegPath = await sdk.mediaManager.getFFmpegPath();
    const ffprobePath = ffmpegPath.replace(/ffmpeg([^/\\]*)$/i, 'ffprobe$1');
    const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'default=nw=1:nk=1',
    ];
    if (protocol === 'rtsp') {
        args.unshift(
            '-rtsp_transport', 'tcp',
            '-rtsp_flags', 'prefer_tcp',
            '-allowed_media_types', 'video',
            '-analyzeduration', '5000000',
            '-probesize', '5000000',
            '-stimeout', '20000000',
        );
    }
    args.push('-i', url);

    return new Promise((resolve) => {
        const child = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve(parseCodecFromProbeOutput(stdout, stderr));
        }, probeTimeoutMs);
        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on('error', () => {
            clearTimeout(timer);
            resolve('unknown');
        });
        child.on('close', () => {
            clearTimeout(timer);
            resolve(parseCodecFromProbeOutput(stdout, stderr));
        });
    });
}

function parseCodecFromProbeOutput(stdout: string, stderr: string): ProbedVideoCodec {
    const fromStdout = parseCodecName(stdout.trim());
    if (fromStdout !== 'unknown') {
        return fromStdout;
    }
    const videoLine = stderr.match(/Video:\s*(\S+)/i);
    if (videoLine) {
        return parseCodecName(videoLine[1]);
    }
    return 'unknown';
}

function parseCodecName(name: string): ProbedVideoCodec {
    const normalized = name.toLowerCase();
    if (normalized.includes('h264') || normalized.includes('avc')) {
        return 'h264';
    }
    if (normalized.includes('hevc') || normalized.includes('h265')) {
        return 'hevc';
    }
    return 'unknown';
}

const CLOUD_RTSP_PROBE_MS = 12_000;
const CLOUD_RTSP_PROBE_INTERVAL_MS = 2000;
/** Short best-effort probe only; do not block Rebroadcast for minutes on 4G wake. */
const CLOUD_RTSP_PROBE_ATTEMPTS = 2;

/**
 * Best-effort codec detect while the cloud relay wakes (4G). Never rejects the session:
 * unknown → caller should assume H.264 copy when the device is configured for H.264.
 */
export async function waitForCloudRtspUrl(url: string): Promise<ProbedVideoCodec> {
    for (let attempt = 1; attempt <= CLOUD_RTSP_PROBE_ATTEMPTS; attempt += 1) {
        const codec = await probeVideoCodec(url, 'rtsp', CLOUD_RTSP_PROBE_MS);
        if (codec !== 'unknown') {
            return codec;
        }
        if (attempt < CLOUD_RTSP_PROBE_ATTEMPTS) {
            await delay(CLOUD_RTSP_PROBE_INTERVAL_MS);
        }
    }
    return 'unknown';
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
