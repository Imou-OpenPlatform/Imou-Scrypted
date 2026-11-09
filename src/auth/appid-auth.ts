import crypto from 'crypto';
import dns from 'dns';
import https from 'https';
import { regionHostFromSetting } from '../regions';

export function regionHost(dataCenter: string | undefined): string {
    return regionHostFromSetting(dataCenter);
}

export class ImouApiError extends Error {
    constructor(readonly code: string, message: string) {
        super(`${code}: ${message}`);
        this.name = 'ImouApiError';
    }
}

interface ApiResult {
    code: string;
    msg: string;
    data: Record<string, any>;
}

/**
 * AppId signature, accessToken cache, and IPv4 HTTPS calls.
 * The token is reused until it is close to expiry, then refreshed once on TK1002.
 */
export class AppIdAuth {
    private token: string | undefined;
    private tokenExpiresAt = 0;
    private host: string;

    constructor(
        private readonly appId: string,
        private readonly appSecret: string,
        region: string | undefined,
    ) {
        this.host = regionHost(region);
    }

    async request(endpoint: string, params: Record<string, any> | undefined, refreshOnExpiry: boolean): Promise<Record<string, any>> {
        const payload = { ...(params ?? {}) };
        if (endpoint !== '/openapi/accessToken') {
            payload.token = await this.tokenValue();
        }
        const result = await this.postWithRetry(endpoint, payload);
        if (result.code === 'TK1002' && refreshOnExpiry) {
            this.token = undefined;
            payload.token = await this.tokenValue();
            const retried = await this.postWithRetry(endpoint, payload);
            if (retried.code !== '0') {
                throw new ImouApiError(retried.code, retried.msg);
            }
            return retried.data;
        }
        if (result.code !== '0') {
            throw new ImouApiError(result.code, result.msg);
        }
        return result.data;
    }

    private async tokenValue(): Promise<string> {
        if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
            return this.token;
        }
        const data = await this.request('/openapi/accessToken', {}, false);
        const token = data.accessToken;
        if (!token) {
            throw new ImouApiError('0', 'accessToken missing');
        }
        this.token = token;
        const expireSeconds = Number(data.expireTime);
        this.tokenExpiresAt = Date.now() + (Number.isFinite(expireSeconds) ? expireSeconds : 60) * 1000;
        if (data.currentDomain) {
            this.host = hostFromDomain(String(data.currentDomain));
        }
        return token;
    }

    private async postWithRetry(endpoint: string, params: Record<string, any>): Promise<ApiResult> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                return await this.postOnce(endpoint, params);
            }
            catch (error) {
                lastError = error;
                if (attempt < 3 && isRetryableNetworkError(error)) {
                    await delay(1500 * attempt);
                    continue;
                }
                break;
            }
        }
        throw lastError;
    }

    private postOnce(endpoint: string, params: Record<string, any>): Promise<ApiResult> {
        const timestamp = Math.round(Date.now() / 1000);
        const nonce = crypto.randomBytes(16).toString('hex');
        const sign = crypto.createHash('md5')
            .update(`time:${timestamp},nonce:${nonce},appSecret:${this.appSecret}`)
            .digest('hex');
        const body = JSON.stringify({
            system: {
                ver: '1.0',
                sign,
                appId: this.appId,
                time: timestamp,
                nonce,
            },
            params,
            id: crypto.randomUUID(),
        });
        return new Promise((resolve, reject) => {
            const request = https.request({
                host: this.host,
                port: 443,
                path: endpoint,
                method: 'POST',
                servername: this.host,
                family: 4,
                timeout: 30000,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                lookup: (hostname, options, callback) => {
                    dns.lookup(hostname, { ...options, family: 4, all: false }, callback);
                },
            }, response => {
                const chunks: Buffer[] = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => {
                    if ((response.statusCode ?? 0) !== 200) {
                        reject(new ImouApiError(String(response.statusCode), endpoint));
                        return;
                    }
                    try {
                        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        const result = parsed?.result;
                        if (!result || result.code === undefined) {
                            reject(new ImouApiError('bad-response', endpoint));
                            return;
                        }
                        resolve({
                            code: String(result.code),
                            msg: result.msg ?? '',
                            data: result.data ?? {},
                        });
                    }
                    catch {
                        reject(new ImouApiError('bad-response', endpoint));
                    }
                });
            });
            request.on('timeout', () => request.destroy(new ImouApiError('timeout', endpoint)));
            request.on('error', reject);
            request.end(body);
        });
    }
}

function hostFromDomain(currentDomain: string): string {
    const raw = currentDomain.includes('://') ? currentDomain : `https://${currentDomain}`;
    return new URL(raw).host;
}

function isRetryableNetworkError(error: unknown): boolean {
    if (error instanceof ImouApiError) {
        return error.code === 'timeout' || error.code === 'bad-response';
    }
    if (error instanceof Error) {
        const msg = error.message;
        return msg.includes('ETIMEDOUT')
            || msg.includes('ECONNRESET')
            || msg.includes('ECONNREFUSED')
            || msg.includes('EAI_AGAIN')
            || msg === 'close';
    }
    return false;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
