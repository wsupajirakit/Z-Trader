import { createHash, timingSafeEqual } from 'crypto';

/** constant-time string comparison that does not leak the length of either input */
export function safeEqual(a: string, b: string): boolean {
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    return timingSafeEqual(ha, hb) && a.length === b.length;
}
