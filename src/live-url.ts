export function liveUrlValid(url: string, marginMs = 60_000): boolean {
    try {
        const expire = Number(new URL(url).searchParams.get('expire'));
        if (!Number.isFinite(expire) || expire <= 0) {
            return true;
        }
        return Date.now() < expire * 1000 - marginMs;
    }
    catch {
        return false;
    }
}

export function refreshBeforeExpire(url: string): number | undefined {
    try {
        const expire = Number(new URL(url).searchParams.get('expire'));
        if (!Number.isFinite(expire) || expire <= 0) {
            return undefined;
        }
        return expire * 1000 - 30_000;
    }
    catch {
        return undefined;
    }
}
