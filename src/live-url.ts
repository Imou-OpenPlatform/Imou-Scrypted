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
