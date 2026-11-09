export type ServerRegionKey = 'sg' | 'eu' | 'na' | 'cn';

export const SERVER_REGION_LABELS: Record<ServerRegionKey, string> = {
    sg: 'Singapore (Asia-Pacific)',
    eu: 'Europe',
    na: 'North America',
    cn: 'China',
};

export const SERVER_REGION_HOSTS: Record<ServerRegionKey, string> = {
    sg: 'openapi-sg.easy4ip.com',
    eu: 'openapi-fk.easy4ip.com',
    na: 'openapi-or.easy4ip.com',
    cn: 'openapi.lechange.cn',
};

const LABEL_TO_KEY = Object.fromEntries(
    (Object.entries(SERVER_REGION_LABELS) as [ServerRegionKey, string][]).map(([key, label]) => [label, key]),
) as Record<string, ServerRegionKey>;

const LEGACY_CODE: Record<string, ServerRegionKey> = {
    SG: 'sg',
    EU: 'eu',
    NA: 'na',
    CN: 'cn',
};

export const SERVER_REGION_CHOICES = [
    SERVER_REGION_LABELS.sg,
    SERVER_REGION_LABELS.eu,
    SERVER_REGION_LABELS.na,
    SERVER_REGION_LABELS.cn,
];

export const DEFAULT_SERVER_REGION = SERVER_REGION_LABELS.sg;

export function normalizeServerRegion(value: unknown): ServerRegionKey {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return 'sg';
    }
    if (LABEL_TO_KEY[raw]) {
        return LABEL_TO_KEY[raw];
    }
    const lower = raw.toLowerCase() as ServerRegionKey;
    if (lower in SERVER_REGION_HOSTS) {
        return lower;
    }
    const legacy = LEGACY_CODE[raw.toUpperCase()];
    if (legacy) {
        return legacy;
    }
    for (const [key, host] of Object.entries(SERVER_REGION_HOSTS) as [ServerRegionKey, string][]) {
        if (raw === host || raw.includes(host)) {
            return key;
        }
    }
    return 'sg';
}

export function regionHostFromSetting(value: unknown): string {
    return SERVER_REGION_HOSTS[normalizeServerRegion(value)];
}
