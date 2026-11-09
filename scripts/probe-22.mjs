/**
 * Plan §2.2: API streaming baseline without Scrypted.
 * Step 1 — getStreamUrl smoke (main/sub).
 * Step 2 — RTSP stability (same path as the plugin / Home Assistant).
 * Optional --hls — bindDeviceLive + HLS (original plan doc path).
 *
 * Requires IMOU_APP_ID and IMOU_APP_SECRET in the environment.
 * Optional IMOU_PROBE_SEC (default 180). Optional IMOU_DATA_CENTER (scripts default SG host).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCredentials } from "./imou-probe-http.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

function run(scriptName, title) {
  console.log(`\n========== ${title} ==========\n`);
  const result = spawnSync(process.execPath, [join(scriptDir, scriptName)], {
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

const { appId, appSecret, dataCenter } = readCredentials();
if (!appId || !appSecret) {
  console.error("请先设置环境变量 IMOU_APP_ID 和 IMOU_APP_SECRET（与插件设置页相同）。");
  console.error("示例:");
  console.error('  export IMOU_APP_ID="你的AppId"');
  console.error('  export IMOU_APP_SECRET="你的AppSecret"');
  console.error('  export IMOU_DATA_CENTER="sg"   # 可选，与插件 Server region 一致');
  console.error("  npm run probe:22");
  process.exit(1);
}
console.log(`AppId 长度 ${appId.length}  serverRegion=${dataCenter}`);
console.log("若出现 SN1004：AppId/AppSecret 与 Scrypted 设置不一致，或复制时多了空格/引号。");

const probeSec = Math.max(30, Number(process.env.IMOU_PROBE_SEC) || 180);
console.log("方案 §2.2 — 开放平台拉流摸底（不经过 Scrypted）");
console.log(`连续拉流时长: ${probeSec} 秒（改 IMOU_PROBE_SEC 可缩短试跑，例如 60）`);
console.log("测试前请关闭手机乐橙 App 预览，避免占云直播位。\n");

const steps = [
  ["probe-stream.mjs", "步骤 1/2: getStreamUrl 是否返回 RTSP（主/子码流）"],
  ["probe-rtsp-metrics.mjs", "步骤 2/2: RTSP 稳定出流（编码、出画耗时、断流次数）"],
];

if (process.argv.includes("--hls")) {
  steps.push(["probe-hls.mjs", "可选: bindDeviceLive + HLS 3 分钟（方案文档路径）"]);
}

let failures = 0;
for (const [script, title] of steps) {
  const code = run(script, title);
  if (code !== 0) {
    failures += 1;
    console.error(`\n${title} 未通过 (exit ${code})。`);
  }
}

console.log("\n========== §2.2 小结 ==========");
if (failures > 0) {
  console.log("有步骤失败。常见原因: FL1005 流量不足、设备被 App 占用、网络/4G 唤醒。");
  console.log("在 Scrypted 里调试之前，请先让本脚本全部通过。");
  process.exit(1);
}

console.log("RTSP 摸底通过。§2.2 验收: 在线机可稳定 getStreamUrl + 连续拉流。");
console.log("下一步 §2.3: 把同一套 getStreamUrl 接到插件 getVideoStream（Scrypted 另有多一层 Rebroadcast/WebRTC）。");
if (!process.argv.includes("--hls")) {
  console.log("若要对比方案里的 HLS 路径: npm run probe:22:hls");
}
