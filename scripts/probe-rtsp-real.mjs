/**
 * RTSP probe aligned with Home Assistant: getStreamUrl, main stream.
 * The url is used as returned. No decryption and no createVideoDownloadStreamUrl.
 * Waits until the relay answers DESCRIBE 200, then opens Windows VLC over RTSP/TCP.
 * Does not create an HLS live. Does not print the AppSecret, accessToken, or RTSP url.
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";

const REGION_HOST = "openapi-sg.easy4ip.com";
const PAGE_SIZE = 50;
const MAX_PAGES = 20;

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

async function post(host, endpoint, params) {
  const url = `https://${host}${endpoint}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody(params)),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`${endpoint} HTTP ${response.status}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${endpoint} 返回的不是 JSON`);
  }
  const result = body?.result;
  if (!result || result.code === undefined) {
    throw new Error(`${endpoint} 缺少 result.code`);
  }
  if (String(result.code) !== "0") {
    throw new Error(`${result.code}: ${result.msg ?? ""}`);
  }
  return result.data ?? {};
}

function hostFromDomain(currentDomain) {
  const raw = String(currentDomain);
  const withScheme = raw.includes("://") ? raw : `https://${raw}`;
  const host = new URL(withScheme).host;
  if (!host) {
    throw new Error("currentDomain 里没有主机名");
  }
  return host;
}

const VLC_PATH = "/mnt/c/Program Files/VideoLAN/VLC/vlc.exe";

function describeOnce(streamUrl) {
  const parsed = new URL(streamUrl);
  const port = Number(parsed.port || 554);
  return new Promise((resolve) => {
    const socket = net.connect({ host: parsed.hostname, port });
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("timeout");
    }, 8000);
    const finish = (status) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    };
    socket.on("error", (error) => finish(error.message));
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      const line = buf.split("\r\n", 1)[0];
      if (line.startsWith("RTSP/")) {
        finish(line);
      }
    });
    socket.on("connect", () => {
      socket.write(
        `DESCRIBE ${streamUrl} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\nUser-Agent: Lavf/60.0.0\r\n\r\n`,
      );
    });
  });
}

async function waitUntilPlayable(streamUrl) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 30000) {
    last = await describeOnce(streamUrl);
    if (last.includes("200")) {
      return { ok: true, waitedMs: Date.now() - started, status: last };
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { ok: false, waitedMs: Date.now() - started, status: last };
}

const tokenData = await post(REGION_HOST, "/openapi/accessToken", {});
const token = tokenData.accessToken;
if (!token) {
  console.error("accessToken 接口成功，但没有返回 token。");
  process.exit(1);
}

let host = REGION_HOST;
if (tokenData.currentDomain) {
  host = hostFromDomain(tokenData.currentDomain);
}
console.log(`host: ${host}`);

const devices = [];
for (let page = 1; page <= MAX_PAGES; page += 1) {
  const data = await post(host, "/openapi/listDeviceDetailsByPage", {
    token,
    page,
    pageSize: PAGE_SIZE,
  });
  const pageDevices = Array.isArray(data.deviceList) ? data.deviceList : [];
  devices.push(...pageDevices);
  if (pageDevices.length < PAGE_SIZE) {
    break;
  }
}

if (devices.length === 0) {
  console.error("没有设备，未请求拉流地址。");
  process.exit(1);
}

let printed = false;
for (const device of devices) {
  const serial = device.deviceId ?? "";
  const productId = device.productId || "";
  const channels = Array.isArray(device.channelList) ? device.channelList : [];
  const channelId = String(channels[0]?.channelId ?? "0");
  console.log(
    `device: name=${device.deviceName ?? ""}  serial=${serial}  productId=${productId || "(none)"}  channel=${channelId}`,
  );

  const params = {
    token,
    deviceId: serial,
    channelId,
    streamId: 0,
  };
  if (productId) {
    params.productId = productId;
  }

  let data;
  try {
    data = await post(host, "/openapi/getStreamUrl", params);
  } catch (error) {
    console.log(`getStreamUrl: ${error instanceof Error ? error.message : error}`);
    continue;
  }

  const streamUrl = data.url ?? "";
  if (!streamUrl.startsWith("rtsp://")) {
    console.log("getStreamUrl: 成功但没有 RTSP 地址");
    continue;
  }

  let parsed;
  try {
    parsed = new URL(streamUrl);
  } catch {
    console.log("getStreamUrl: 返回的不是 URL");
    continue;
  }
  console.log(`getStreamUrl: scheme=${parsed.protocol}  host=${parsed.host}`);
  console.log("等待摄像机把画面推上来，最多 30 秒。");
  const ready = await waitUntilPlayable(streamUrl);
  console.log(`describe: ${ready.status}  waited=${Math.round(ready.waitedMs / 1000)}s`);
  if (!ready.ok) {
    continue;
  }
  if (!existsSync(VLC_PATH)) {
    console.log("本机没有找到 Windows VLC。");
    continue;
  }
  const child = spawn(VLC_PATH, ["--rtsp-tcp", streamUrl], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  printed = true;
  console.log("已打开 VLC。看窗口里有没有画面。");
}

if (!printed) {
  console.log("VLC 没有打开。这次没有创建 HLS。");
  process.exit(1);
}
