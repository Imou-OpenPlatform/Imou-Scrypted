/**
 * IPv4-only HTTPS for Imou Open API probe scripts (WSL fetch often fails on IPv6).
 */
import crypto from "node:crypto";
import dns from "node:dns";
import { existsSync, readFileSync } from "node:fs";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".imou-probe.env");

/** Same keys/hosts as Imou Life (HA) and plugin src/regions.ts */
const SERVER_REGION_HOSTS = {
  sg: "openapi-sg.easy4ip.com",
  eu: "openapi-fk.easy4ip.com",
  na: "openapi-or.easy4ip.com",
  cn: "openapi.lechange.cn",
};

const SERVER_REGION_LABELS = {
  sg: "Singapore (Asia-Pacific)",
  eu: "Europe",
  na: "North America",
  cn: "China",
};

const LABEL_TO_KEY = Object.fromEntries(
  Object.entries(SERVER_REGION_LABELS).map(([key, label]) => [label, key]),
);

export function normalizeServerRegion(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "sg";
  }
  if (LABEL_TO_KEY[raw]) {
    return LABEL_TO_KEY[raw];
  }
  const lower = raw.toLowerCase();
  if (lower in SERVER_REGION_HOSTS) {
    return lower;
  }
  const legacy = { SG: "sg", EU: "eu", NA: "na", CN: "cn" }[raw.toUpperCase()];
  if (legacy) {
    return legacy;
  }
  for (const [key, host] of Object.entries(SERVER_REGION_HOSTS)) {
    if (raw === host || raw.includes(host)) {
      return key;
    }
  }
  return "sg";
}

export function regionHost(dataCenter) {
  return SERVER_REGION_HOSTS[normalizeServerRegion(dataCenter)];
}

/** Optional file: Imou-Scrypted/.imou-probe.env (same values as Scrypted plugin settings). */
export function loadProbeEnvFile() {
  if (!existsSync(PROBE_ENV_PATH)) {
    return false;
  }
  const text = readFileSync(PROBE_ENV_PATH, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}

export function readCredentials() {
  loadProbeEnvFile();
  const appId = (process.env.IMOU_APP_ID ?? "").trim();
  const appSecret = (process.env.IMOU_APP_SECRET ?? "").trim();
  const dataCenter = normalizeServerRegion(process.env.IMOU_DATA_CENTER ?? "sg");
  return { appId, appSecret, dataCenter };
}

export function explainApiError(code, dataCenter) {
  if (String(code) !== "SN1004") {
    return "";
  }
  const host = regionHost(dataCenter);
  return [
    "",
    "SN1004 = 开放平台不认可当前 AppId（不是拉流失败，是鉴权没过）。",
    `当前 serverRegion=${normalizeServerRegion(dataCenter)}，accessToken 入口 host=${host}。`,
    "请与 Scrypted → Imou Camera 插件设置页逐字核对 App ID / App Secret / Server region。",
    "终端 export 与插件是两套：插件能列出摄像机，不代表本 shell 里的变量正确。",
    `也可复制 .imou-probe.env.example → .imou-probe.env 填入同一套值（勿提交 git）。`,
  ].join("\n");
}

export function createClient(appId, appSecret) {
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
          timeout: 30000,
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

  async function post(host, endpoint, params, meta = {}) {
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
          const hint = explainApiError(result.code, meta.dataCenter ?? "sg");
          throw new Error(`${result.code}: ${result.msg ?? ""}${hint}`);
        }
        return result.data ?? {};
      }
      catch (error) {
        lastError = error;
        if (attempt === 2) {
          break;
        }
      }
    }
    throw lastError;
  }

  return { post };
}

export function hostFromDomain(currentDomain) {
  const raw = String(currentDomain);
  const withScheme = raw.includes("://") ? raw : `https://${raw}`;
  const host = new URL(withScheme).host;
  if (!host) {
    throw new Error("currentDomain 里没有主机名");
  }
  return host;
}
