import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import {
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { safeEqual } from '../common/utils/safe-equal';

/**
 * Live indicator feed for zTraderActor (server-to-server). The handshake must carry the API key, either
 * as the `x-api-key` header or as `auth.apiKey`. Browsers are not clients of this namespace, so CORS
 * stays closed.
 */
@WebSocketGateway({ namespace: 'klines', cors: { origin: false } })
export class KlinesGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer() server!: Server;
    private readonly logger = new Logger(KlinesGateway.name);

    constructor(private readonly config: ConfigService) {}

    afterInit(server: Server) {
        server.use((socket, next) => {
            const expected = this.config.get<string>('API_KEY', '');
            const header = socket.handshake.headers['x-api-key'];
            const auth = (socket.handshake.auth as { apiKey?: unknown } | undefined)?.apiKey;
            const given = typeof header === 'string' ? header : typeof auth === 'string' ? auth : '';
            if (!expected || !given || !safeEqual(given, expected)) {
                this.logger.warn(`rejected klines socket from ${socket.handshake.address}`);
                return next(new Error('unauthorized'));
            }
            next();
        });
        this.logger.log('Klines WebSocket Gateway initialized (API key required)');
    }

    handleConnection(client: Socket) {
        this.logger.log(`Client connected: ${client.id}`);
    }

    handleDisconnect(client: Socket) {
        this.logger.log(`Client disconnected: ${client.id}`);
    }

    @OnEvent('indicators.updated')
    handleIndicatorsEvent(payload: { symbol: string }) {
        this.logger.debug(`pushing indicators for ${payload.symbol}`);
        this.server.emit('indicators', payload);
    }
}
