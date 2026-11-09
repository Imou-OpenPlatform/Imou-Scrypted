/**
 * §2.1 probe: exchange accessToken, then list bound devices.
 * Reads IMOU_APP_ID and IMOU_APP_SECRET from the environment.
 * Does not print the secret or the token, and does not open a live stream.
 */
import crypto from "node:crypto";

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
    throw new Error(`${endpoint} ${result.code}: ${result.msg ?? ""}`);
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
console.log(
  `token: ok${tokenData.expireTime !== undefined ? `, expireTime=${tokenData.expireTime}` : ""}`,
);

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
  if (page === MAX_PAGES) {
    console.log(`已取 ${MAX_PAGES} 页，后面的设备没有继续拉。`);
  }
}

console.log(`devices: ${devices.length}`);
if (devices.length === 0) {
  console.log("token 换到了，但这套 AppId 下没有设备。");
  process.exit(0);
}

devices.forEach((device, index) => {
  const channels = Array.isArray(device.channelList) ? device.channelList : [];
  console.log(
    [
      `${index + 1}.`,
      `name=${device.deviceName ?? ""}`,
      `serial=${device.deviceId ?? ""}`,
      `model=${device.deviceModel ?? ""}`,
      `status=${device.deviceStatus ?? ""}`,
      `channels=${channels.length}`,
    ].join("  "),
  );
  for (const channel of channels) {
    console.log(
      `   channel ${channel.channelId ?? ""}  name=${channel.channelName ?? ""}  status=${channel.channelStatus ?? ""}`,
    );
  }
});
