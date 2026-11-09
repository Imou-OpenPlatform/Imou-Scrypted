/**
 * Verify Open Platform AppId / AppSecret (accessToken only).
 */
import {
  createClient,
  loadProbeEnvFile,
  readCredentials,
  regionHost,
} from "./imou-probe-http.mjs";

const loadedFile = loadProbeEnvFile();
const { appId, appSecret, dataCenter } = readCredentials();

if (!appId || !appSecret) {
  console.error("缺少 IMOU_APP_ID / IMOU_APP_SECRET。");
  console.error("在 shell 里 export，或复制 .imou-probe.env.example → .imou-probe.env");
  process.exit(1);
}

const host = regionHost(dataCenter);
console.log(`serverRegion=${dataCenter}  host=${host}  AppId 长度=${appId.length}${loadedFile ? "  (.imou-probe.env 已加载)" : ""}`);

const { post } = createClient(appId, appSecret);
await post(host, "/openapi/accessToken", {}, { dataCenter });
console.log("accessToken 成功。开放平台鉴权 OK，可再跑 npm run probe:22:url 拿 VLC 地址。");
