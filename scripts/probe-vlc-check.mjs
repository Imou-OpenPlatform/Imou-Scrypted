/**
 * One ticket + immediate ffprobe (TCP). Confirms the URL is playable before VLC.
 * Imou cloud RTSP usually requires RTSP/RTP over TCP; VLC defaults to UDP.
 */
import { spawn } from "node:child_process";
import {
  createClient,
  hostFromDomain,
  readCredentials,
  regionHost,
} from "./imou-probe-http.mjs";

const { appId, appSecret, dataCenter } = readCredentials();
if (!appId || !appSecret) {
  console.error("缺少 IMOU_APP_ID / IMOU_APP_SECRET 或 .imou-probe.env");
  process.exit(1);
}

const { post } = createClient(appId, appSecret);
const regionEntry = regionHost(dataCenter);
const tokenData = await post(regionEntry, "/openapi/accessToken", {}, { dataCenter });
const token = tokenData.accessToken;
if (!token) {
  console.error("无 accessToken");
  process.exit(1);
}
let host = regionEntry;
if (tokenData.currentDomain) {
  host = hostFromDomain(tokenData.currentDomain);
}

const list = await post(
  host,
  "/openapi/listDeviceDetailsByPage",
  { token, page: 1, pageSize: 50 },
  { dataCenter },
);
const device = (Array.isArray(list.deviceList) ? list.deviceList : [])[0];
if (!device) {
  console.error("无设备");
  process.exit(1);
}
const serial = device.deviceId ?? "";
const channelId = String(device.channelList?.[0]?.channelId ?? "0");
const stream = await post(
  host,
  "/openapi/getStreamUrl",
  { token, deviceId: serial, channelId, streamId: 0 },
  { dataCenter },
);
const url = stream.url ?? "";
if (!url.startsWith("rtsp://")) {
  console.error("getStreamUrl 无 RTSP");
  process.exit(1);
}

console.log(`device ${device.deviceName ?? serial}`);
console.log("--- 复制下面整行到 VLC（须开 RTSP over TCP，见说明）---");
console.log(url);
console.log("---");

const probe = await ffprobeTcp(url);
if (probe.codec) {
  console.log(`本机 ffprobe(TCP) OK：${probe.codec}，耗时 ${probe.ms} ms`);
  console.log("");
  console.log("Windows VLC 若仍失败，几乎总是未强制 TCP 或 Scrypted/App 占线：");
  console.log("  1) 完全退出乐橙 App 预览；Scrypted 关 Main Prebuffer / 不要 Play");
  console.log("  2) VLC：工具 → 偏好 → 输入/编解码器 → 勾选「RTP over RTSP (TCP)」→ 保存");
  console.log("  3) 或 PowerShell：vlc --rtsp-tcp \"<粘贴 URL>\"");
  console.log("  4) 拿 URL 后 10 秒内打开；不要先跑 probe:22:rtsp（会占这条票）");
  process.exit(0);
}
console.error(`本机 ffprobe(TCP) 失败 (${probe.ms} ms): ${probe.err}`);
console.error("若 ffprobe 也失败：App 占线、4G 休眠，或开发者流量 FL1005。");
process.exit(1);

function ffprobeTcp(rtspUrl) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        "tcp",
        "-rtsp_flags",
        "prefer_tcp",
        "-i",
        rtspUrl,
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "default=nw=1:nk=1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ms: Date.now() - started, err: "timeout 15s" });
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ms: Date.now() - started, err: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const name = stdout.trim().toLowerCase();
      if (code === 0 && name) {
        resolve({ ms: Date.now() - started, codec: name });
        return;
      }
      resolve({
        ms: Date.now() - started,
        err: stderr.trim().slice(0, 240) || `exit ${code}`,
      });
    });
  });
}
