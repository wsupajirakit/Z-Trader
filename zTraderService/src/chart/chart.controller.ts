import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequireRole } from '../common/auth/auth.decorators';
import type { ChartStreamEvent } from './chart-feeds';
import { ChartService } from './chart.service';
import { ChartBarsQuery, ChartStreamQuery, ChartSymbolQuery } from './dto/chart.dto';

/** SSE comment line sent this often so proxies and the browser keep an idle stream open */
const HEARTBEAT_MS = 15_000;

/**
 * Chart data for the dashboard: candles from the account's cTrader broker or from TradingView.
 * Browser routes: signed-in session only (the API key is not accepted), any role.
 */
@Controller('api/chart')
@RequireRole('viewer')
export class ChartController {
    constructor(private readonly chart: ChartService) {}

    @Get('sources')
    sources(@Query() q: ChartSymbolQuery) {
        return this.chart.sources(q.symbol);
    }

    @Get('bars')
    bars(@Query() q: ChartBarsQuery) {
        return this.chart.bars(q.symbol, q.source, q.tf, q.limit);
    }

    /**
     * Server-Sent Events: `status` {state, message?} and `bar` {time, open, high, low, close, volume}
     * for the forming bar, plus a `: ping` comment every 15 s.
     */
    @Get('stream')
    stream(@Query() q: ChartStreamQuery, @Req() req: Request, @Res() res: Response): void {
        // validate before any byte is written, so a bad source is still a normal 400 JSON answer
        this.chart.assertSource(q.symbol, q.source);

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        req.socket.setNoDelay(true);
        res.write('retry: 3000\n\n');

        const send = (e: ChartStreamEvent) => {
            if (!res.writableEnded) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
        };
        let leave: (() => void) | null = null;
        const heartbeat = setInterval(() => {
            if (!res.writableEnded) res.write(': ping\n\n');
        }, HEARTBEAT_MS);
        heartbeat.unref();

        let done = false;
        const cleanup = () => {
            if (done) return;
            done = true;
            clearInterval(heartbeat);
            leave?.();
            leave = null;
        };
        req.on('close', cleanup);
        res.on('close', cleanup);
        res.on('error', cleanup);

        leave = this.chart.subscribe(q.symbol, q.source, q.tf, send);
        if (done) {
            // the client vanished while we were subscribing
            leave();
            leave = null;
        }
    }
}
