/**
 * §2.2 probe: getStreamUrl for each bound device.
 * streamId 0 is the main stream, streamId 1 is the sub stream.
 * Does not create an HLS live. Does not print the AppSecret or accessToken.
 */
import {
  createClient,
  hostFromDomain,
  readCredentials,
  regionHost,
} from "./imou-probe-http.mjs";

const PAGE_SIZE = 50;
const MAX_PAGES = 20;
/** Default main only: a second getStreamUrl often kills the first ticket on 4G / single-session devices. */
const STREAM_IDS = process.env.IMOU_PROBE_BOTH_STREAMS === "1" ? [0, 1] : [0];

const { appId, appSecret, dataCenter } = readCredentials();

if (!appId || !appSecret) {
  console.error("缺少环境变量 IMOU_APP_ID 或 IMOU_APP_SECRET。");
  process.exit(1);
}

const { post } = createClient(appId, appSecret);
const regionEntry = regionHost(dataCenter);

const tokenData = await post(regionEntry, "/openapi/accessToken", {}, { dataCenter });
const token = tokenData.accessToken;
if (!token) {
  console.error("accessToken 接口成功，但没有返回 token。");
  process.exit(1);
}

let host = regionEntry;
if (tokenData.currentDomain) {
  host = hostFromDomain(tokenData.currentDomain);
}
console.log(`serverRegion=${dataCenter}  host=${host}`);
console.log(`AppId 长度 ${appId.length}（若 SN1004，请与 Scrypted 插件设置页逐字核对）`);

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

let gotUrl = false;
for (const device of devices) {
  const serial = device.deviceId ?? "";
  const productId = device.productId || "";
  const channels = Array.isArray(device.channelList) ? device.channelList : [];
  const channelId = channels[0]?.channelId ?? "0";
  console.log(
    `device: name=${device.deviceName ?? ""}  serial=${serial}  productId=${productId || "(none)"}  channel=${channelId}`,
  );

  for (const streamId of STREAM_IDS) {
    const label = streamId === 0 ? "main" : "sub";
    const params = {
      token,
      deviceId: serial,
      channelId: String(channelId),
      streamId,
    };
    if (productId) {
      params.productId = productId;
    }
    try {
      const data = await post(host, "/openapi/getStreamUrl", params);
      const streamUrl = data.url ?? "";
      if (!streamUrl) {
        console.log(`streamId ${streamId} (${label}): 成功但没有 url`);
        continue;
      }
      gotUrl = true;
      const parsed = new URL(streamUrl);
      console.log(
        `streamId ${streamId} (${label}): ok  scheme=${parsed.protocol}  host=${parsed.host}`,
      );
      console.log(streamUrl);
    }
    catch (error) {
      console.log(
        `streamId ${streamId} (${label}): ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

if (!gotUrl) {
  console.log("两条码流都没有 RTSP 地址。这次没有创建 HLS。");
  process.exit(1);
}

console.log("用上面打印的 RTSP 在 VLC 里播放（媒体 → 打开网络串流，建议 RTSP over TCP）。");
if (STREAM_IDS.length === 1) {
  console.log("只申请了主码流。若要主+子两条一起测，请 IMOU_PROBE_BOTH_STREAMS=1（VLC 请仍只用其中一条）。");
}
console.log("拿到 URL 后尽快播放；不要同时开 App 预览。这次没有创建 HLS。");
