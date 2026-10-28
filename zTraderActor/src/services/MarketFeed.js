import { EventEmitter } from 'node:events';
import { io as connect } from 'socket.io-client';
import { tradeLog } from '../logging/logger.js';

/**
 * socket.io client for zTraderService's `/klines` namespace.
 * Emits `connect` and `indicators` (the raw payload from the service).
 */
export class MarketFeed extends EventEmitter {
    /** @param {{ url: string, apiKey: string }} service */
    constructor(service) {
        super();
        this.service = service;
        this.socket = null;
    }

    connect() {
        if (this.socket) this.socket.disconnect();

        this.socket = connect(this.service.url + '/klines', {
            extraHeaders: { 'x-api-key': this.service.apiKey },
        });

        this.socket.on('connect', () => {
            tradeLog.info('[ทำ] 🔌 Connected to Market Data Gateway');
            this.emit('connect');
        });
        this.socket.on('indicators', (payload) => this.emit('indicators', payload));
        this.socket.on('error', (err) => {
            tradeLog.error('[รอ] Market Socket Error:', err);
        });
    }

    close() {
        this.socket?.disconnect();
        this.socket = null;
    }
}
