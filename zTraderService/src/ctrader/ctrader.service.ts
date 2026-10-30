import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import * as protobuf from 'protobufjs';
import * as path from 'path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { errorMessage, errorStack } from '../common/utils/errors';
import { HISTORY_MIN_INTERVAL_MS, HISTORY_REQUESTS, RequestLimiter, retryOnRateLimit } from './history-limiter';

const HEARTBEAT_MS = 10_000; // ต้องต่ำกว่า idle timeout ~30s ของ cTrader ให้มีที่เหลือเฟือ

@Injectable()
export class CtraderService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(CtraderService.name);
    private ws!: WebSocket;
    private root!: protobuf.Root;
    private heartbeatInterval?: NodeJS.Timeout;
    private reconnectTimeout?: NodeJS.Timeout;
    private isConnected = false;
    private shuttingDown = false;
    private isAccountAuthorized = false;
    /** spaces out historical-data requests (cTrader allows ~5/s per app) */
    private readonly historyLimiter = new RequestLimiter(HISTORY_MIN_INTERVAL_MS);

    private _activeAccountId!: number;
    private pendingRequests = new Map<
        string,
        { resolve: (data: any) => void; reject: (error: any) => void; timeout: NodeJS.Timeout }
    >();
    private clientMsgIdCounter = 0;

    public get activeAccountId(): number {
        return this._activeAccountId;
    }

    public get isAuthorized(): boolean {
        return this.isAccountAuthorized;
    }

    constructor(
        private configService: ConfigService,
        private eventEmitter: EventEmitter2,
    ) {}

    async onModuleInit() {
        await this.loadProtobuf();
        this.connect();
    }

    private async loadProtobuf() {
        this.root = new protobuf.Root();
        const protoDir = path.join(process.cwd(), 'proto');
        await this.root.load(path.join(protoDir, 'OpenApiCommonMessages.proto'), { keepCase: true });
        await this.root.load(path.join(protoDir, 'OpenApiCommonModelMessages.proto'), { keepCase: true });
        await this.root.load(path.join(protoDir, 'OpenApiMessages.proto'), { keepCase: true });
        this.logger.log('Protobuf files loaded');
    }

    private connect() {
        if (this.shuttingDown) return;
        const mode = this.configService.get<string>('CTRADER_ACCOUNT_MODE', 'DEMO').toUpperCase();
        // CTRADER_HOST only overrides the endpoint (tests point it at a closed local port)
        const host =
            this.configService.get<string>('CTRADER_HOST') ||
            (mode === 'LIVE' ? 'live.ctraderapi.com' : 'demo.ctraderapi.com');
        const port = this.configService.get<number>('CTRADER_PORT', 5035);

        this.logger.log(`[MODE: ${mode}] Connecting to cTrader at wss://${host}:${port}`);
        this.ws = new WebSocket(`wss://${host}:${port}`);

        this.ws.on('open', () => {
            this.isConnected = true;
            this.logger.log('WebSocket Connected to cTrader');
            this.startHeartbeat();
            this.authenticate();
        });

        this.ws.on('message', (data: Buffer) => {
            this.handleMessage(data);
        });

        this.ws.on('close', () => {
            this.isConnected = false;
            // ต้องล้างสถานะ authorized ด้วย — ไม่งั้น guard ทั้งระบบยังคิดว่าต่ออยู่
            // แล้วเดินหน้าส่งคำขอที่หายไปเงียบ ๆ (send() no-op) จนหมดเวลารอ
            this.isAccountAuthorized = false;
            // subscription ทั้งหมดตายไปกับ session เดิม — ล้างทะเบียนเพื่อให้แต่ละโมดูลสมัครใหม่ได้
            this.spotOwners.clear();
            this.logger.warn('WebSocket Disconnected. Reconnecting...');
            this.stopHeartbeat();
            this.failPending('WebSocket disconnected while awaiting a response');
            this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
            this.logger.error('WebSocket Error', errorMessage(error));
        });
    }

    private authenticate() {
        const payload = {
            clientId: this.configService.get('APP_ID'),
            clientSecret: this.configService.get('APP_SECRET'),
        };
        try {
            this.send('ProtoOAApplicationAuthReq', payload);
        } catch (e) {
            this.logger.error(`Failed to send app auth: ${errorMessage(e)}`);
        }
    }

    private authorizeAccount() {
        const mode = this.configService.get<string>('CTRADER_ACCOUNT_MODE', 'DEMO');
        const accountIdKey = mode === 'LIVE' ? 'LIVE_ACCOUNT_ID' : 'DEMO_ACCOUNT_ID';
        const accountId = Number(this.configService.get(accountIdKey));
        const accessToken = this.configService.get('ACCESS_TOKEN');

        if (!accountId || !accessToken) {
            this.logger.error(
                `Missing configuration for ${mode} account: ID=${accountId}, Token=${accessToken ? '***' : 'Missing'}`,
            );
            return;
        }

        this._activeAccountId = accountId;
        this.logger.log(`Sending authorization request for ${mode} account: ${accountId}`);

        const payload = {
            ctidTraderAccountId: accountId,
            accessToken: accessToken,
        };
        try {
            this.send('ProtoOAAccountAuthReq', payload);
        } catch (e) {
            this.logger.error(`Failed to send account auth: ${errorMessage(e)}`);
        }
    }

    private handleMessage(data: Buffer) {
        try {
            const ProtoMessage = this.root.lookupType('ProtoMessage');
            const message = ProtoMessage.decode(data) as any;
            const payloadType = message.payloadType;
            const clientMsgId = message.clientMsgId;

            // Log raw incoming data (except heartbeats and frequent spot events)
            if (payloadType !== 51 && payloadType !== 2131 && payloadType !== 2125) {
                try {
                    const typeName = this.getNameByPayloadType(payloadType);
                    if (typeName) {
                        const type = this.root.lookupType(typeName);
                        const decoded = type.decode(message.payload);
                        this.logger.debug(`[RAW_RECV] ${typeName} (${payloadType}): ${JSON.stringify(decoded)}`);
                    } else {
                        this.logger.debug(`[RAW_RECV] Unknown Type (${payloadType})`);
                    }
                } catch (e) {
                    this.logger.debug(`[RAW_RECV] Failed to decode (${payloadType})`);
                }
            }

            // Resolve pending requests if clientMsgId matches
            if (clientMsgId && this.pendingRequests.has(clientMsgId)) {
                const pending = this.pendingRequests.get(clientMsgId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    this.pendingRequests.delete(clientMsgId);

                    // If it's an error response, reject
                    if (payloadType === 2142) {
                        const type = this.root.lookupType('ProtoOAErrorRes');
                        const error = type.decode(message.payload) as any;
                        pending.reject(error);
                        return;
                    }

                    // Attempt to decode the payload based on type
                    const typeName = this.getNameByPayloadType(payloadType);
                    if (typeName) {
                        try {
                            const type = this.root.lookupType(typeName);
                            const decoded = type.decode(message.payload);
                            pending.resolve(decoded);
                        } catch (e) {
                            // a response missing a field the .proto marks required: protobufjs throws a
                            // ProtocolError that still carries everything it decoded, which beats raw bytes
                            const partial = (e as { instance?: unknown } | null)?.instance;
                            if (e instanceof protobuf.util.ProtocolError && partial) {
                                this.logger.debug(`${typeName}: ${errorMessage(e)} — using the fields decoded so far`);
                                pending.resolve(partial);
                            } else {
                                this.logger.error(`Failed to decode response of type ${typeName}`, errorStack(e));
                                pending.resolve(message.payload);
                            }
                        }
                    } else {
                        pending.resolve(message.payload);
                    }
                    return;
                }
            }

            // 51 = ProtoHeartbeatEvent
            if (payloadType === 51) {
                // Heartbeat received
                // this.logger.debug('[DEBUG] Heartbeat received from server');
                return;
            }

            // 2101 = ProtoOAApplicationAuthRes
            if (payloadType === 2101) {
                this.logger.log('Application authenticated. Authorizing account...');
                this.authorizeAccount();
            }

            // 2103 = ProtoOAAccountAuthRes
            if (payloadType === 2103) {
                this.isAccountAuthorized = true;
                this.logger.log(`Account ${this._activeAccountId} authorized successfully`);
            }
            // 2131 = ProtoOASpotEvent
            if (payloadType === 2131) {
                const type = this.root.lookupType('ProtoOASpotEvent');
                const decoded = type.decode(message.payload);
                this.eventEmitter.emit('ctrader.spot', decoded);
                return;
            }

            // 2135 = ProtoOATrendbarEvent
            if (payloadType === 2135) {
                const type = this.root.lookupType('ProtoOATrendbarEvent');
                const decoded = type.decode(message.payload);
                this.eventEmitter.emit('ctrader.trendbar', decoded);
                return;
            }

            // 2126 = ProtoOAExecutionEvent
            if (payloadType === 2126) {
                const type = this.root.lookupType('ProtoOAExecutionEvent');
                const decoded: any = type.decode(message.payload);
                // Attach the clientMsgId so we can correlate it to our UUID
                if (clientMsgId) {
                    decoded.clientMsgId = clientMsgId;
                }
                this.eventEmitter.emit('ctrader.execution', decoded);
                return;
            }
        } catch (e) {
            this.logger.error('Failed to decode message', errorStack(e));
        }
    }

    /** socket ยังต่ออยู่ไหม — ใช้เช็คว่าต้องสมัครรับราคาใหม่หลัง reconnect หรือเปล่า */
    public get connected(): boolean {
        return this.isConnected;
    }

    /**
     * ใครสมัครรับราคาของ symbol ไหนอยู่บ้าง
     *
     * spot subscription ของ cTrader เป็นระดับ session ของบัญชี ไม่ได้แยกต่อผู้เรียก —
     * ถ้าโมดูลหนึ่ง unsubscribe อีกโมดูลที่ใช้ symbol เดียวกันจะขาดฟีดไปด้วย
     * (เจอจริง: สลับตราสารในบอททอง แล้ว klines gateway ตายถาวรจนต้องรีสตาร์ท)
     * จึงนับผู้ใช้งานไว้ แล้วยกเลิกจริงเฉพาะตอนไม่มีใครใช้แล้ว
     */
    private spotOwners = new Map<number, Set<string>>();

    /** symbol นี้มีคนอื่นนอกจาก owner ใช้อยู่ไหม */
    public isSpotSharedWith(symbolId: number, owner = ''): boolean {
        const set = this.spotOwners.get(symbolId);
        if (!set) return false;
        return [...set].some((o) => o !== owner);
    }

    public async subscribeSpots(symbolId: number, owner = 'unknown') {
        if (!this.isAuthorized) {
            throw new Error('Account not authorized');
        }
        const set = this.spotOwners.get(symbolId) ?? new Set<string>();
        set.add(owner);
        this.spotOwners.set(symbolId, set);
        this.logger.log(`Subscribing to spots for Symbol ID: ${symbolId} (owner: ${owner})`);
        return this.request<any>('ProtoOASubscribeSpotsReq', {
            ctidTraderAccountId: this._activeAccountId,
            symbolId: [symbolId],
            subscribeToSpotTimestamp: true,
        });
    }

    /**
     * ยกเลิกก่อนสมัครใหม่ — ไม่งั้น server ตอบ ALREADY_SUBSCRIBED แล้วราคาก็ยังค้างเหมือนเดิม
     * @param force ยกเลิกจริงแม้ยังมีผู้ใช้งานอื่น (ใช้ตอน re-subscribe ของเจ้าของเดียวกัน)
     */
    public async unsubscribeSpots(symbolId: number, owner = 'unknown', force = false) {
        if (!this.isAuthorized) {
            throw new Error('Account not authorized');
        }
        const set = this.spotOwners.get(symbolId);
        set?.delete(owner);
        if (!force && set && set.size > 0) {
            this.logger.log(`Skipping unsubscribe ${symbolId} — still in use by: ${[...set].join(', ')}`);
            return null;
        }
        this.spotOwners.delete(symbolId);
        this.logger.log(`Unsubscribing spots for Symbol ID: ${symbolId}`);
        return this.request<any>('ProtoOAUnsubscribeSpotsReq', {
            ctidTraderAccountId: this._activeAccountId,
            symbolId: [symbolId],
        });
    }

    public async subscribeLiveTrendbar(symbolId: number, period: number = 1) {
        if (!this.isAuthorized) {
            throw new Error('Account not authorized');
        }
        this.logger.log(`Subscribing to live Trendbars (M${period}) for Symbol ID: ${symbolId}`);
        return this.request<any>('ProtoOASubscribeLiveTrendbarReq', {
            ctidTraderAccountId: this._activeAccountId,
            symbolId,
            period: period,
        });
    }

    public async getPositions() {
        if (!this.isAccountAuthorized) return { position: [] };
        return this.request<any>('ProtoOAReconcileReq', {
            ctidTraderAccountId: this._activeAccountId,
            returnOpenPositions: true,
        });
    }

    public async amendPositionSLTP(positionId: number, stopLoss?: number, takeProfit?: number) {
        if (!this.isAccountAuthorized) throw new Error('Account not authorized');
        return this.request<any>('ProtoOAAmendPositionSLTPReq', {
            ctidTraderAccountId: this._activeAccountId,
            positionId: positionId,
            stopLoss: stopLoss,
            takeProfit: takeProfit,
        });
    }

    public async getSymbolById(symbolId: number) {
        if (!this.isAccountAuthorized) throw new Error('Account not authorized');
        return this.request<any>('ProtoOASymbolByIdReq', {
            ctidTraderAccountId: this._activeAccountId,
            symbolId: [symbolId],
        });
    }

    public async getDealsByPositionId(positionId: number) {
        if (!this.isAccountAuthorized) throw new Error('Account not authorized');
        return this.request<any>('ProtoOADealListByPositionIdReq', {
            ctidTraderAccountId: this._activeAccountId,
            positionId,
        });
    }

    /** deal list ฝั่ง server ช้ากว่า request อื่นชัดเจน — default 20s (ไม่ใช่ 10s) */
    public async getDealList(fromTimestamp: number, toTimestamp: number, timeoutMs = 20_000) {
        if (!this.isAccountAuthorized) throw new Error('Account not authorized');
        return this.request<any>(
            'ProtoOADealListReq',
            {
                ctidTraderAccountId: this._activeAccountId,
                fromTimestamp,
                toTimestamp,
            },
            timeoutMs,
        );
    }

    public async cancelOrder(orderId: number) {
        if (!this.isAccountAuthorized) throw new Error('Account not authorized');
        return this.request<any>('ProtoOACancelOrderReq', {
            ctidTraderAccountId: this._activeAccountId,
            orderId: orderId,
        });
    }

    /**
     * Sends a request and waits for its answer. Historical-data requests (deal lists, trendbars) are
     * spaced by a shared limiter and retried with backoff if cTrader still answers "rate limited",
     * so callers never see a rate-limit error unless it persists.
     */
    public async request<T>(payloadTypeName: string, payload: any, timeoutMs: number = 10000): Promise<T> {
        if (!HISTORY_REQUESTS.has(payloadTypeName)) return this.sendAndWait<T>(payloadTypeName, payload, timeoutMs);
        return retryOnRateLimit(
            () => this.historyLimiter.schedule(() => this.sendAndWait<T>(payloadTypeName, payload, timeoutMs)),
            {
                onRetry: (attempt, delay) =>
                    this.logger.warn(`${payloadTypeName} rate limited — retry ${attempt} in ${delay} ms`),
            },
        );
    }

    private sendAndWait<T>(payloadTypeName: string, payload: any, timeoutMs: number): Promise<T> {
        return new Promise((resolve, reject) => {
            const clientMsgId = `req_${++this.clientMsgIdCounter}`;
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(clientMsgId);
                reject(new Error(`Request ${payloadTypeName} timed out (${clientMsgId})`));
            }, timeoutMs);

            this.pendingRequests.set(clientMsgId, { resolve, reject, timeout });
            try {
                this.send(payloadTypeName, payload, clientMsgId);
            } catch (e) {
                clearTimeout(timeout);
                this.pendingRequests.delete(clientMsgId);
                reject(e instanceof Error ? e : new Error(errorMessage(e)));
            }
        });
    }

    public send(payloadTypeName: string, payload: any, clientMsgId?: string) {
        if (!this.isConnected) {
            // เดิม log แล้ว return เฉย ๆ = คำขอหายไปเงียบ ๆ ผู้เรียกรอจนหมดเวลาแล้วนึกว่า
            // "server ช้า" ทั้งที่จริงคือไม่ได้ส่งออกไปเลย (26 ส.ค.: 93 ครั้งใน 1 วัน)
            // โยน error ให้ request() reject ทันที จะได้เห็นสาเหตุจริง
            throw new Error('cTrader is not connected — cannot send request');
        }

        try {
            const type = this.root.lookupType(payloadTypeName);
            const payloadBuffer = type.encode(type.create(payload)).finish();

            const ProtoMessage = this.root.lookupType('ProtoMessage');
            const payloadType = this.getPayloadTypeByName(payloadTypeName);

            const message = ProtoMessage.create({
                payloadType: payloadType,
                payload: payloadBuffer,
                clientMsgId: clientMsgId,
            });

            const buffer = ProtoMessage.encode(message).finish();
            this.ws.send(buffer);
        } catch (e) {
            this.logger.error(`Error sending ${payloadTypeName}`, errorStack(e));
        }
    }

    private getNameByPayloadType(payloadType: number): string | undefined {
        const mapping = this.getMapping();
        return Object.keys(mapping).find((key) => mapping[key] === payloadType);
    }

    private getPayloadTypeByName(name: string): number {
        const mapping = this.getMapping();
        return mapping[name];
    }

    private getMapping(): Record<string, number> {
        return {
            ProtoOAApplicationAuthReq: 2100,
            ProtoOAApplicationAuthRes: 2101,
            ProtoOAAccountAuthReq: 2102,
            ProtoOAAccountAuthRes: 2103,
            ProtoOATraderReq: 2104,
            ProtoOATraderRes: 2105,
            ProtoOASymbolsListReq: 2114,
            ProtoOASymbolsListRes: 2115,
            ProtoOASymbolByIdReq: 2116,
            ProtoOASymbolByIdRes: 2117,
            ProtoOANewOrderReq: 2106, // Standard NewOrderReq is 2106
            ProtoOASubscribeSpotsReq: 2127,
            ProtoOASubscribeSpotsRes: 2128,
            ProtoOAUnsubscribeSpotsReq: 2129,
            ProtoOAUnsubscribeSpotsRes: 2130,
            ProtoOASpotEvent: 2131,
            ProtoOASubscribeLiveTrendbarReq: 2135,
            ProtoOASubscribeLiveTrendbarRes: 2165,
            ProtoOAUnsubscribeLiveTrendbarReq: 2136,
            ProtoOAUnsubscribeLiveTrendbarRes: 2166,
            ProtoOAGetTrendbarsReq: 2137,
            ProtoOAGetTrendbarsRes: 2138,
            ProtoOAErrorRes: 2142,
            ProtoOAReconcileReq: 2124,
            ProtoOAReconcileRes: 2125,
            ProtoOAAmendPositionSLTPReq: 2107,
            ProtoOAAmendPositionSLTPRes: 2108,
            ProtoOAExecutionEvent: 2126,
            ProtoOAOrderErrorEvent: 2132,
            ProtoOADealListByPositionIdReq: 2179,
            ProtoOADealListByPositionIdRes: 2180,
            ProtoOACancelOrderReq: 2109,
            ProtoOACancelOrderRes: 2110,
            ProtoOADealListReq: 2133,
            ProtoOADealListRes: 2134,
            ProtoHeartbeatEvent: 51,
        };
    }

    /**
     * cTrader ตัดการเชื่อมต่อที่เงียบเกิน ~30 วินาที
     * เดิมตั้ง 25s = เฉียดเพดาน เจอ network jitter นิดเดียวก็หลุด
     * (26 ส.ค.: หลุด 43 ครั้งใน 1 วัน ทำให้ deal list timeout ทุกครั้งที่เรียก)
     */
    private startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (!this.isConnected) return;
            try {
                this.send('ProtoHeartbeatEvent', {});
            } catch {
                /* หลุดพอดี — on('close') จัดการต่อ */
            }
        }, HEARTBEAT_MS);
    }

    private stopHeartbeat() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    }

    /** ตัดจบคำขอที่ค้างอยู่ทั้งหมด — ดีกว่าปล่อยให้ผู้เรียกรอจนครบ timeout แล้วเข้าใจผิดว่า server ช้า */
    private failPending(reason: string) {
        if (!this.pendingRequests.size) return;
        this.logger.warn(`Cancelling ${this.pendingRequests.size} pending request(s): ${reason}`);
        for (const [, p] of this.pendingRequests) {
            clearTimeout(p.timeout);
            p.reject(new Error(reason));
        }
        this.pendingRequests.clear();
    }

    private scheduleReconnect() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        if (this.shuttingDown) return;
        this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
    }

    /** the socket's close handler would otherwise schedule a reconnect after shutdown */
    onModuleDestroy() {
        this.shuttingDown = true;
        this.stopHeartbeat();
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        this.failPending('service shutting down');
        if (this.ws) this.ws.close();
    }
}
