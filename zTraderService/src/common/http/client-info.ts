import type { Request } from 'express';

/**
 * Client address as Express resolves it. With TRUST_PROXY=n Express takes the n-th hop from the right
 * of X-Forwarded-For (the part our own proxy wrote); with 0 it is the socket peer. Either way a client
 * cannot choose it by sending its own header.
 */
export function clientIp(req: Request): string {
    return (req.ip || req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

export function userAgent(req: Request): string {
    return String(req.headers['user-agent'] ?? '').slice(0, 300);
}
