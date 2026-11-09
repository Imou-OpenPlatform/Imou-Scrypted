/**
 * Measure one Home Assistant-style getStreamUrl pull.
 * Codec comes from the SDP. Stalls are gaps in frame arrival.
 * Latency is local receive time minus the relay RTCP sender clock.
 * Prints the RTSP url for manual playback. Does not open VLC or create HLS.
 */
import crypto from "node:crypto";
import dns from "node:dns";
import https from "node:https";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { readCredentials, regionHost } from "./imou-probe-http.mjs";

const { appId, appSecret, dataCenter } = readCredentials();
const REGION_HOST = regionHost(dataCenter);
const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const DURATION_SEC = Math.max(30, Number(process.env.IMOU_PROBE_SEC) || 180);
const STALL_SEC = 1;
const NTP_UNIX_EPOCH = 2208988800;

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

async function post(host, endpoint, params) {
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
      if (String(result.code) !== "0") {
        throw new Error(`${result.code}: ${result.msg ?? ""}`);
      }
      return result.data ?? {};
    } catch (error) {
      lastError = error;
      if (attempt === 2) {
        break;
      }
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

function parseRtp(packet) {
  if (packet.length < 12 || packet[0] >> 6 !== 2) {
    return null;
  }
  const padding = (packet[0] >> 5) & 1;
  const extension = (packet[0] >> 4) & 1;
  const cc = packet[0] & 0x0f;
  const marker = (packet[1] >> 7) & 1;
  const pt = packet[1] & 0x7f;
  const timestamp = packet.readUInt32BE(4);
  const ssrc = packet.readUInt32BE(8);
  let offset = 12 + cc * 4;
  if (extension) {
    if (packet.length < offset + 4) {
      return null;
    }
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  let end = packet.length;
  if (padding && end > offset) {
    end -= packet[end - 1];
  }
  if (offset > end) {
    return null;
  }
  return { marker, pt, timestamp, ssrc, payload: packet.subarray(offset, end) };
}

function parseSenderReports(packet) {
  const reports = [];
  let offset = 0;
  while (offset + 8 <= packet.length) {
    const type = packet[offset + 1];
    const size = (packet.readUInt16BE(offset + 2) + 1) * 4;
    if (offset + size > packet.length) {
      break;
    }
    if (type === 200 && size >= 28) {
      const ntpMsw = packet.readUInt32BE(offset + 8);
      const ntpLsw = packet.readUInt32BE(offset + 12);
      reports.push({
        ssrc: packet.readUInt32BE(offset + 4),
        ntp: ntpMsw - NTP_UNIX_EPOCH + ntpLsw / 2 ** 32,
        rtpTs: packet.readUInt32BE(offset + 16),
      });
    }
    offset += size;
  }
  return reports;
}

function rtpDelta(timestamp, srTimestamp) {
  let delta = timestamp - srTimestamp;
  if (delta > 0x80000000) {
    delta -= 0x100000000;
  }
  if (delta < -0x80000000) {
    delta += 0x100000000;
  }
  return delta;
}

function frameLatency(arrivalMs, rtpTimestamp, report) {
  const ntp = report.ntp + rtpDelta(rtpTimestamp, report.rtpTs) / 90000;
  return arrivalMs / 1000 - ntp;
}

function resolveControl(requestUrl, contentBase, control) {
  if (!control || control === "*") {
    return requestUrl;
  }
  if (control.startsWith("rtsp://")) {
    return control;
  }
  const base = new URL(contentBase || requestUrl);
  if (!base.pathname.endsWith("/")) {
    base.pathname += "/";
  }
  base.pathname += control.replace(/^\//, "");
  return base.href;
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

function measure(streamUrl, urlReadyAt) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(streamUrl);
    const socket = net.connect(Number(parsed.port || 554), parsed.hostname);
    let buf = Buffer.alloc(0);
    let stage = "describe";
    let cseq = 1;
    let session = "";
    let videoPt = null;
    let codec = "";
    let rtpChannel = 0;
    let rtcpChannel = 1;
    let playStarted = null;
    let firstFrameAt = null;
    let nextProgress = 30;
    let settled = false;
    const reports = new Map();
    const frameWall = [];
    const latencies = [];

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timer);
      socket.destroy();
      if (error && frameWall.length === 0) {
        reject(error);
        return;
      }
      resolve({ codec, firstFrameAt, frameWall, latencies, playStarted, error });
    };

    const send = (method, uri, headers = {}) => {
      const lines = [
        `${method} ${uri} RTSP/1.0`,
        `CSeq: ${cseq}`,
        "User-Agent: imou-probe",
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        "",
        "",
      ];
      cseq += 1;
      socket.write(lines.join("\r\n"));
    };

    const handleRtsp = (header, body) => {
      const status = header.split("\r\n")[0];
      if (!status.includes("200")) {
        finish(new Error(status));
        return;
      }
      if (stage === "describe") {
        const sdp = body.toString("utf8");
        for (const block of sdp.split(/\r?\nm=/).slice(1)) {
          if (!block.startsWith("video")) {
            continue;
          }
          const mapped = block.match(/a=rtpmap:(\d+)\s+([^/\s]+)/i);
          if (mapped) {
            videoPt = Number(mapped[1]);
            codec = mapped[2];
          }
          const control = block.match(/a=control:(\S+)/)?.[1] ?? "";
          const contentBase = header.match(/Content-Base:\s*(\S+)/i)?.[1];
          stage = "setup";
          send("SETUP", resolveControl(streamUrl, contentBase, control), {
            Transport: "RTP/AVP/TCP;unicast;interleaved=0-1",
          });
          return;
        }
        finish(new Error("SDP 里没有视频"));
        return;
      }
      if (stage === "setup") {
        session = header.match(/Session:\s*([^;\r\n]+)/i)?.[1]?.trim() ?? "";
        const channels = header.match(/interleaved=(\d+)-(\d+)/i);
        if (channels) {
          rtpChannel = Number(channels[1]);
          rtcpChannel = Number(channels[2]);
        }
        stage = "play";
        send("PLAY", streamUrl, { Session: session, Range: "npt=0.000-" });
        return;
      }
      if (stage === "play") {
        stage = "interleaved";
        playStarted = Date.now();
      }
    };

    const handleRtp = (packet) => {
      const rtp = parseRtp(packet);
      if (!rtp || rtp.pt !== videoPt || !rtp.marker) {
        return;
      }
      const now = Date.now();
      if (firstFrameAt === null) {
        firstFrameAt = now;
      }
      frameWall.push(now);
      const report = reports.get(rtp.ssrc);
      if (report) {
        const latency = frameLatency(now, rtp.timestamp, report);
        if (Number.isFinite(latency)) {
          latencies.push(latency);
        }
      }
      if (!playStarted) {
        return;
      }
      const elapsed = (now - playStarted) / 1000;
      if (elapsed >= nextProgress) {
        console.log(`已拉 ${nextProgress}s，帧数 ${frameWall.length}`);
        nextProgress += 30;
      }
    };

    socket.on("connect", () => {
      send("DESCRIBE", streamUrl, { Accept: "application/sdp" });
    });
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length > 0) {
        if (stage !== "interleaved") {
          const sep = buf.indexOf("\r\n\r\n");
          if (sep < 0) {
            return;
          }
          const header = buf.subarray(0, sep).toString("latin1");
          const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1] ?? 0);
          if (buf.length < sep + 4 + length) {
            return;
          }
          const body = buf.subarray(sep + 4, sep + 4 + length);
          buf = buf.subarray(sep + 4 + length);
          handleRtsp(header, body);
          continue;
        }
        if (buf[0] !== 0x24) {
          const sep = buf.indexOf("\r\n\r\n");
          if (sep < 0) {
            return;
          }
          const length = Number(
            buf.subarray(0, sep).toString("latin1").match(/Content-Length:\s*(\d+)/i)?.[1] ?? 0,
          );
          if (buf.length < sep + 4 + length) {
            return;
          }
          buf = buf.subarray(sep + 4 + length);
          continue;
        }
        if (buf.length < 4) {
          return;
        }
        const channel = buf[1];
        const length = buf.readUInt16BE(2);
        if (buf.length < 4 + length) {
          return;
        }
        const payload = buf.subarray(4, 4 + length);
        buf = buf.subarray(4 + length);
        if (channel === rtpChannel) {
          handleRtp(payload);
        } else if (channel === rtcpChannel) {
          for (const report of parseSenderReports(payload)) {
            reports.set(report.ssrc, report);
          }
        }
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish());
    const timer = setInterval(() => {
      if (playStarted && Date.now() - playStarted >= DURATION_SEC * 1000) {
        if (session) {
          send("TEARDOWN", streamUrl, { Session: session });
        }
        finish();
      }
    }, 500);
    socket.setTimeout(20000, () => finish(new Error("20 秒没有收到数据")));
  });
}

function latencyLine(values) {
  const mid = percentile(values, 0.5);
  const p95 = percentile(values, 0.95);
  if (mid === null) {
    return "时延: 没有 RTCP 时钟，算不出";
  }
  if (mid < 0 || mid > 120) {
    return `时延: RTCP 时钟对不上（中位数 ${mid.toFixed(1)} 秒）`;
  }
  return `时延: 中位数 ${mid.toFixed(1)} 秒，P95 ${p95.toFixed(1)} 秒`;
}

if (process.env.IMOU_SELF_TEST === "1") {
  const report = { ntp: 1_700_000_000, rtpTs: 90_000 };
  const latency = frameLatency(1_700_000_000_000 + 2500, 90_000 + 90_000, report);
  if (Math.abs(latency - 1.5) > 0.01) {
    console.error("latency self-test failed", latency);
    process.exit(1);
  }
  const sr = Buffer.alloc(28);
  sr[0] = 0x80;
  sr[1] = 200;
  sr.writeUInt16BE(6, 2);
  sr.writeUInt32BE(1_700_000_000 + NTP_UNIX_EPOCH, 8);
  sr.writeUInt32BE(90_000, 16);
  const parsed = parseSenderReports(sr);
  if (parsed.length !== 1 || Math.abs(parsed[0].ntp - 1_700_000_000) > 0.001) {
    console.error("rtcp self-test failed");
    process.exit(1);
  }
  console.log("self-test ok");
  process.exit(0);
}

if (!appId || !appSecret) {
  console.error("缺少环境变量 IMOU_APP_ID 或 IMOU_APP_SECRET。");
  process.exit(1);
}

const tokenData = await post(REGION_HOST, "/openapi/accessToken", {}, { dataCenter });
const token = tokenData.accessToken;
if (!token) {
  console.error("accessToken 接口成功，但没有返回 token。");
  process.exit(1);
}
let host = REGION_HOST;
if (tokenData.currentDomain) {
  host = hostFromDomain(tokenData.currentDomain);
}

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
  console.error("没有设备。");
  process.exit(1);
}

const summaries = [];
for (const device of devices) {
  const serial = device.deviceId ?? "";
  const productId = device.productId || "";
  const channelId = String(device.channelList?.[0]?.channelId ?? "0");
  const params = { token, deviceId: serial, channelId, streamId: 0 };
  if (productId) {
    params.productId = productId;
  }
  const data = await post(host, "/openapi/getStreamUrl", params);
  const streamUrl = data.url ?? "";
  if (!streamUrl.startsWith("rtsp://")) {
    console.log(`${device.deviceName ?? serial}: getStreamUrl 没有返回 RTSP 地址`);
    continue;
  }
  const urlReadyAt = Date.now();
  console.log(
    `device: name=${device.deviceName ?? ""}  serial=${serial}  model=${device.deviceModel ?? ""}`,
  );
  console.log("手动播放用下面这一行。脚本马上开始测量，会占用这条地址：");
  console.log(streamUrl);
  console.log(`接口: getStreamUrl 主码流。开始拉 ${DURATION_SEC} 秒。`);
  const result = await measure(streamUrl, urlReadyAt);
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
  const fps = wallSec > 0 ? result.frameWall.length / wallSec : 0;
  const startup =
    result.firstFrameAt === null ? null : (result.firstFrameAt - urlReadyAt) / 1000;
  const longest = stalls.length ? Math.max(...stalls) : 0;
  const lines = [
    `设备: ${device.deviceName ?? ""}  ${serial}  ${device.deviceModel ?? ""}`,
    "接口: getStreamUrl 主码流",
    `编码: ${codecLabel(result.codec)}`,
    `帧率: ${fps ? fps.toFixed(1) : "未知"}`,
    `出画耗时: ${startup === null ? "没有画面" : `${startup.toFixed(1)} 秒`}`,
    latencyLine(result.latencies),
    `测量: ${DURATION_SEC} 秒`,
    `收到视频帧: ${result.frameWall.length}`,
    `断流次数: ${stalls.length}（实际收到画面的间隔 ≥ ${STALL_SEC} 秒）`,
    `最长中断: ${longest.toFixed(1)} 秒`,
    `连接: ${wallSec >= DURATION_SEC - 15 ? "拉满" : "中途断开"}`,
  ];
  if (result.error && result.frameWall.length === 0) {
    lines.push(`备注: ${result.error.message}`);
  }
  lines.push(`rtsp: ${streamUrl}`);
  summaries.push(lines.join("\n"));
  console.log(summaries[summaries.length - 1]);
}

if (summaries.length === 0) {
  process.exit(1);
}
writeFileSync("/tmp/imou-rtsp-metrics.txt", `${summaries.join("\n\n")}\n`);
