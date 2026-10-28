import { isValidSymbol, MAX_SYMBOLS, normalizeMode } from '../strategies/modes.js';

export class ConfigError extends Error {
    constructor(problems) {
        super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
        this.name = 'ConfigError';
        this.problems = problems;
    }
}

const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'];

/**
 * Reads and validates the environment once at boot. Every other module receives the
 * resulting frozen object instead of reading process.env itself.
 *
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
    const problems = [];
    const str = (name) => {
        const v = env[name];
        return v === undefined || v.trim() === '' ? undefined : v.trim();
    };
    const int = (name, { def, min, max }) => {
        const raw = str(name);
        if (raw === undefined) return def;
        const n = Number(raw);
        if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
            problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
            return def;
        }
        return n;
    };
    const num = (name, { def, min }) => {
        const raw = str(name);
        if (raw === undefined) return def;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= min) {
            problems.push(`${name} must be a number greater than ${min} (got "${raw}")`);
            return def;
        }
        return n;
    };

    // --- zTraderService ---
    let serviceUrl = str('API_TRADER_URL');
    if (!serviceUrl) {
        problems.push('API_TRADER_URL is required (base URL of zTraderService, e.g. http://ztrader-service:6500)');
    } else {
        try {
            const u = new URL(serviceUrl);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
            serviceUrl = serviceUrl.replace(/\/+$/, '');
        } catch {
            problems.push('API_TRADER_URL must be an absolute http(s) URL');
        }
    }
    const apiKey = str('API_KEY');
    if (!apiKey) problems.push('API_KEY is required');
    else if (apiKey.length < 32) problems.push('API_KEY must be at least 32 characters');

    // --- HTTP ---
    const port = int('PORT', { def: 3000, min: 1, max: 65535 });
    const trustProxy = int('TRUST_PROXY', { def: 0, min: 0, max: 10 });
    const logLevel = (str('LOG_LEVEL') ?? 'info').toLowerCase();
    if (!LOG_LEVELS.includes(logLevel)) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

    // --- trading loop ---
    const symbols = (str('SYMBOL') ?? 'XAUUSD')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (symbols.length === 0 || symbols.length > MAX_SYMBOLS || !symbols.every(isValidSymbol)) {
        problems.push(`SYMBOL must be a comma-separated list of 1-${MAX_SYMBOLS} symbols like XAUUSD`);
    }
    const mode = normalizeMode(str('STRATEGY_MODE') ?? 'Sonic');
    if (!mode) problems.push('STRATEGY_MODE must be one of Hardcode, Conservative, Swing, Merge, Sonic, Scalper');

    const trading = {
        symbols,
        mode,
        maxPositions: int('MAX_POSITIONS', { def: 1, min: 1, max: 100 }),
        tradeAmountUsd: num('TRADE_AMOUNT_USD', { def: 10, min: 0 }),
        tradeLotSize: num('TRADE_LOT_SIZE', { def: null, min: 0 }),
    };

    if (problems.length) throw new ConfigError(problems);

    return Object.freeze({
        port,
        trustProxy,
        logLevel,
        service: Object.freeze({ url: serviceUrl, apiKey }),
        trading: Object.freeze(trading),
    });
}
