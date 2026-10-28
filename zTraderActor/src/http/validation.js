/**
 * Small, explicit validators for everything the browser can send to the gold proxy.
 * Each returns `{ value }` or `{ error }`; routes answer 400 with the error text.
 */

// zTraderService modes are lower-case words (scalp, intraday, swing, position).
const MODE = /^[a-z][a-z0-9_-]{0,31}$/;
// Archive files are "<YYYYMMDD_HHmmss>_<mode>.json". Only one dot is allowed, so no "..".
const ARCHIVE_FILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/;
const INSTRUMENT = /^[A-Z0-9]{3,16}$/;
const SETTING_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const SETTING_STRING = /^[A-Za-z0-9 ._-]{0,64}$/;
const MAX_LIST = 10;
const MAX_SETTINGS = 32;

const ok = (value) => ({ value });
const fail = (error) => ({ error });

/** Optional integer query parameter in [min, max]. */
export function intParam(raw, { name, def, min, max }) {
    if (raw === undefined) return ok(def);
    if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw)) return fail(`${name} must be an integer`);
    const n = Number(raw);
    if (n < min || n > max) return fail(`${name} must be between ${min} and ${max}`);
    return ok(n);
}

export function archivePath({ mode, file }) {
    if (!MODE.test(mode)) return fail('invalid archive mode');
    if (!ARCHIVE_FILE.test(file)) return fail('invalid archive file name');
    return ok({ mode, file });
}

export function flagParam(raw, name) {
    if (raw === undefined) return ok(false);
    if (raw === '1' || raw === 'true') return ok(true);
    if (raw === '0' || raw === 'false') return ok(false);
    return fail(`${name} must be 1/true or 0/false`);
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function onlyKeys(body, allowed) {
    const extra = Object.keys(body).filter((k) => !allowed.includes(k));
    return extra.length ? `unexpected field(s): ${extra.join(', ')}` : null;
}

/** POST /api/gold/run  { mode, force? } */
export function runBody(body) {
    if (!isPlainObject(body)) return fail('JSON object body required');
    const extra = onlyKeys(body, ['mode', 'force']);
    if (extra) return fail(extra);
    if (typeof body.mode !== 'string' || !MODE.test(body.mode)) return fail('mode is required');
    if (body.force !== undefined && typeof body.force !== 'boolean') return fail('force must be a boolean');
    return ok({ mode: body.mode, ...(body.force !== undefined && { force: body.force }) });
}

/** POST /api/gold/automate  { enabled, modes?, instruments? } */
export function automateBody(body) {
    if (!isPlainObject(body)) return fail('JSON object body required');
    const extra = onlyKeys(body, ['enabled', 'modes', 'instruments']);
    if (extra) return fail(extra);
    if (typeof body.enabled !== 'boolean') return fail('enabled must be a boolean');
    const out = { enabled: body.enabled };
    for (const [key, pattern] of [
        ['modes', MODE],
        ['instruments', INSTRUMENT],
    ]) {
        if (body[key] === undefined) continue;
        const list = body[key];
        if (
            !Array.isArray(list) ||
            list.length > MAX_LIST ||
            !list.every((v) => typeof v === 'string' && pattern.test(v))
        ) {
            return fail(`${key} must be a list of at most ${MAX_LIST} valid names`);
        }
        out[key] = list;
    }
    return ok(out);
}

/**
 * POST /api/gold/settings  partial settings. The service owns the list of keys and their
 * ranges; here we only enforce a safe shape: flat object, simple keys, scalar values.
 */
export function settingsBody(body) {
    if (!isPlainObject(body)) return fail('JSON object body required');
    const entries = Object.entries(body);
    if (entries.length === 0 || entries.length > MAX_SETTINGS) return fail(`1-${MAX_SETTINGS} settings expected`);
    for (const [key, value] of entries) {
        if (!SETTING_KEY.test(key)) return fail(`invalid setting name: ${key.slice(0, 64)}`);
        const valid =
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value)) ||
            (typeof value === 'string' && SETTING_STRING.test(value));
        if (!valid) return fail(`invalid value for ${key}`);
    }
    return ok(Object.fromEntries(entries));
}

/**
 * POST /login  { username, password } — usernames are 3-32 of [a-z0-9._-], stored lower-case.
 * Length caps match the service's LoginDto (username 1-64, password 1-128).
 */
export function loginBody(body) {
    if (!isPlainObject(body)) return fail('username and password are required');
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
        return fail('username and password are required');
    }
    if (username.length > 64 || password.length > 128) return fail('username or password too long');
    return ok({ username: username.trim().toLowerCase(), password });
}

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
