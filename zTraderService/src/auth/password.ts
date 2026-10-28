import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'crypto';

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
    new Promise<Buffer>((resolve, reject) =>
        scryptCb(pw, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key))),
    );

/**
 * scrypt with OWASP's 32 MiB profile (N=2^15, r=8, p=3). Parameters travel inside the hash, so they can
 * be raised later: `needsRehash()` flags old hashes and AuthService rewrites them on the next login.
 *
 * format: scrypt$<log2N>$<r>$<p>$<salt b64url>$<hash b64url>
 */
const PARAMS = { logN: 15, r: 8, p: 3 };
const KEY_LEN = 64;
const SALT_LEN = 16;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_LEN);
    const key = await derive(password, salt, PARAMS.logN, PARAMS.r, PARAMS.p);
    return ['scrypt', PARAMS.logN, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) return false;
    const key = await derive(password, parsed.salt, parsed.logN, parsed.r, parsed.p);
    return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

export function needsRehash(stored: string): boolean {
    const p = parse(stored);
    return !p || p.logN < PARAMS.logN || p.r !== PARAMS.r || p.p !== PARAMS.p;
}

/** returns a reason in Thai when the password is not acceptable, otherwise null */
export function passwordProblem(password: string, username: string): string | null {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN)
        return `รหัสผ่านต้องยาวอย่างน้อย ${PASSWORD_MIN} ตัวอักษร`;
    if (password.length > PASSWORD_MAX) return `รหัสผ่านต้องไม่เกิน ${PASSWORD_MAX} ตัวอักษร`;
    if (username && password.toLowerCase().includes(username.toLowerCase()))
        return 'รหัสผ่านต้องไม่มีชื่อผู้ใช้อยู่ข้างใน';
    return null;
}

function derive(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
    const N = 2 ** logN;
    // scrypt needs 128·N·r bytes; give it headroom so Node does not refuse with "memory limit exceeded"
    return scrypt(password.normalize('NFKC'), salt, KEY_LEN, { N, r, p, maxmem: 256 * N * r });
}

function parse(stored: string) {
    const parts = typeof stored === 'string' ? stored.split('$') : [];
    if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
    const [logN, r, p] = parts.slice(1, 4).map(Number);
    if (![logN, r, p].every(Number.isInteger) || logN < 10 || logN > 20) return null;
    return { logN, r, p, salt: Buffer.from(parts[4], 'base64url'), key: Buffer.from(parts[5], 'base64url') };
}
