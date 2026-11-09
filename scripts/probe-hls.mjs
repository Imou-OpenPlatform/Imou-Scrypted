/**
 * HLS stability probe: bindDeviceLive (main stream), play 180s, then unbindLive.
 * If a live already exists (LV1001), it is reused and still closed at the end.
 * IPv4 only. Does not print the AppSecret or accessToken.
 */
import crypto from "node:crypto";
import dns from "node:dns";
import https from "node:https";
import { spawn } from "node:child_process";

const REGION_HOST = "openapi-sg.easy4ip.com";
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const DURATION_SEC = Math.max(30, Number(process.env.IMOU_PROBE_SEC) || 180);
const STALL_SEC = 1;

const appId = process.env.IMOU_APP_ID ?? "";
const appSecret = process.env.IMOU_APP_SECRET ?? "";

if (!appId || !appSecret) {
  console.error("缺少环境变量 IMOU_APP_ID 或 IMOU_APP_SECRET。");
  process.exit(1);
}

function sign(timestamp, nonce) {
  return crypto
    .createHash("md5")
    .update(`time:${timestamp},nonce:${nonce},appSecret:${appSecret}`)
    .digest("hex");
}

function requestBody(params) {
  const timestamp = Math.round(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  return {
    system: {
      ver: "1.0",
      sign: sign(timestamp, nonce),
      appId,
      time: timestamp,
      nonce,
    },
    params,
    id: crypto.randomUUID(),
  };
}

function postOnce(host, endpoint, params) {
  const payload = JSON.stringify(requestBody(params));
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host,
        port: 443,
        path: endpoint,
        method: "POST",
        servername: host,
        family: 4,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 20000,
        lookup: (hostname, options, callback) => {
          dns.lookup(hostname, { ...options, family: 4, all: false }, callback);
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error(`${endpoint} 连接超时`)));
    request.on("error", reject);
    request.end(payload);
  });
}

async function callApi(host, endpoint, params) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await postOnce(host, endpoint, params);
      if (response.status !== 200) {
        throw new Error(`${endpoint} HTTP ${response.status}`);
      }
      const body = JSON.parse(response.text);
      const result = body?.result;
      if (!result || result.code === undefined) {
        throw new Error(`${endpoint} 缺少 result.code`);
      }
      return {
        code: String(result.code),
        msg: result.msg ?? "",
        data: result.data ?? {},
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function hostFromDomain(currentDomain) {
  const raw = String(currentDomain);
  const withScheme = raw.includes("://") ? raw : `https://${raw}`;
  return new URL(withScheme).host;
}

function codecLabel(name) {
  const value = name.toLowerCase();
  if (value === "h264" || value === "avc") {
    return "H.264";
  }
  if (value === "hevc" || value === "h265") {
    return "H.265";
  }
  return name || "未知";
}

function pickMainHls(data) {
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const main = streams.filter((stream) => Number(stream.streamId) === 0 && stream.hls);
  const pool = main.length ? main : streams.filter((stream) => stream.hls);
  const on = pool.filter((stream) => String(stream.status) === "1");
  const candidates = on.length ? on : pool;
  return (
    candidates.find((stream) => String(stream.hls).startsWith("https://")) ??
    candidates[0] ??
    null
  );
}

function measure(playlistUrl, startedAt) {
  return new Promise((resolve) => {
    const frameWall = [];
    let codec = "";
    let resolution = "";
    let fps = "";
    let note = "";
    let nextProgress = 30;
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-i",
      playlistUrl,
      "-t",
      String(DURATION_SEC),
      "-an",
      "-vf",
      "showinfo",
      "-f",
      "null",
      "-",
    ]);
    let buf = "";
    const takeLine = (line) => {
      if (line.includes("Video:") && !codec) {
        codec = line.match(/Video:\s*([^\s,(]+)/)?.[1] ?? "";
        resolution = line.match(/(\d{2,5}x\d{2,5})/)?.[1] ?? "";
        fps = line.match(/([\d.]+)\s*fps/)?.[1] ?? "";
      }
      if (line.includes("pts_time:")) {
        const now = Date.now();
        frameWall.push(now);
        const elapsed = (now - startedAt) / 1000;
        if (elapsed >= nextProgress) {
          console.log(`已拉 ${nextProgress}s，帧数 ${frameWall.length}`);
          nextProgress += 30;
        }
      }
      if (/error|failed|404|403|timed out/i.test(line) && !line.includes("showinfo")) {
        note = line.replace(/https?:\/\/\S+/g, "http://REDACTED").slice(0, 240);
      }
    };
    child.stderr.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        takeLine(line);
      }
    });
    child.on("close", (code) => {
      if (buf) {
        takeLine(buf);
      }
      resolve({ code, frameWall, codec, resolution, fps, note });
    });
  });
}

const tokenData = await callApi(REGION_HOST, "/openapi/accessToken", {});
if (tokenData.code !== "0" || !tokenData.data.accessToken) {
  console.error(`accessToken ${tokenData.code}: ${tokenData.msg}`);
  process.exit(1);
}
const token = tokenData.data.accessToken;
let host = REGION_HOST;
if (tokenData.data.currentDomain) {
  host = hostFromDomain(tokenData.data.currentDomain);
}

const devices = [];
for (let page = 1; page <= MAX_PAGES; page += 1) {
  const listed = await callApi(host, "/openapi/listDeviceDetailsByPage", {
    token,
    page,
    pageSize: PAGE_SIZE,
  });
  if (listed.code !== "0") {
    console.error(`listDeviceDetailsByPage ${listed.code}: ${listed.msg}`);
    process.exit(1);
  }
  const pageDevices = Array.isArray(listed.data.deviceList) ? listed.data.deviceList : [];
  devices.push(...pageDevices);
  if (pageDevices.length < PAGE_SIZE) {
    break;
  }
}
const device = devices[0];
if (!device) {
  console.error("没有设备。");
  process.exit(1);
}

const serial = device.deviceId ?? "";
const channelId = String(device.channelList?.[0]?.channelId ?? "0");
console.log(
  `device: name=${device.deviceName ?? ""}  serial=${serial}  model=${device.deviceModel ?? ""}  channel=${channelId}`,
);

const created = await callApi(host, "/openapi/bindDeviceLive", {
  token,
  deviceId: serial,
  channelId,
  streamId: 0,
});
if (created.code === "0") {
  console.log("bindDeviceLive: 已创建主码流直播");
} else if (created.code === "LV1001") {
  console.log("bindDeviceLive: 直播已存在，改为查询");
} else {
  console.error(`bindDeviceLive ${created.code}: ${created.msg}`);
  process.exit(1);
}

const info = await callApi(host, "/openapi/getLiveStreamInfo", {
  token,
  deviceId: serial,
  channelId,
});
const live = info.code === "0" ? pickMainHls(info.data) : pickMainHls(created.data);
if (!live?.hls) {
  console.error(`getLiveStreamInfo ${info.code}: ${info.msg || "没有 HLS 地址"}`);
  process.exit(1);
}
const liveToken = live.liveToken || info.data.liveToken || created.data.liveToken;
console.log(`hls: streamId=${live.streamId ?? "?"}  status=${live.status ?? "?"}`);
console.log("这 3 分钟里可以用下面的地址播放。测完会关闭直播：");
console.log(live.hls);

const startedAt = Date.now();
let result;
try {
  result = await measure(live.hls, startedAt);
} finally {
  if (!liveToken) {
    console.log("关闭直播: 没有 liveToken，没有调用 unbindLive");
  } else {
    try {
      const closed = await callApi(host, "/openapi/unbindLive", { token, liveToken });
      console.log(
        closed.code === "0"
          ? "关闭直播: 已调用 unbindLive"
          : `关闭直播失败 ${closed.code}: ${closed.msg}`,
      );
    } catch (error) {
      console.log(`关闭直播失败: ${error instanceof Error ? error.message : error}`);
    }
  }
}

const stalls = [];
for (let index = 1; index < result.frameWall.length; index += 1) {
  const gap = (result.frameWall[index] - result.frameWall[index - 1]) / 1000;
  if (gap >= STALL_SEC) {
    stalls.push(gap);
  }
}
const wallSec =
  result.frameWall.length > 1
    ? (result.frameWall[result.frameWall.length - 1] - result.frameWall[0]) / 1000
    : 0;
const startup = result.frameWall.length ? (result.frameWall[0] - startedAt) / 1000 : null;
const longest = stalls.length ? Math.max(...stalls) : 0;
const summary = [
  `设备: ${device.deviceName ?? ""}  ${serial}  ${device.deviceModel ?? ""}`,
  "接口: bindDeviceLive / getLiveStreamInfo 主码流 HLS",
  `编码: ${codecLabel(result.codec)}`,
  `分辨率: ${result.resolution || "未知"}`,
  `帧率: ${result.fps || (wallSec > 0 ? (result.frameWall.length / wallSec).toFixed(1) : "未知")}`,
  `出画耗时: ${startup === null ? "没有画面" : `${startup.toFixed(1)} 秒`}`,
  `测量: ${DURATION_SEC} 秒`,
  `收到视频帧: ${result.frameWall.length}`,
  `断流次数: ${stalls.length}（实际收到画面的间隔 ≥ ${STALL_SEC} 秒）`,
  `最长中断: ${longest.toFixed(1)} 秒`,
  `连接: ${wallSec >= DURATION_SEC - 15 ? "拉满" : "中途断开"}`,
  result.note ? `备注: ${result.note}` : "",
  `hls: ${live.hls}`,
]
  .filter(Boolean)
  .join("\n");
console.log(summary);
if (result.frameWall.length === 0) {
  process.exit(1);
}
