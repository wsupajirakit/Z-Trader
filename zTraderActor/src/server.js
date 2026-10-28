import { createActor } from './actor.js';
import { ConfigError, loadConfig } from './config/env.js';
import { log, setLogLevel } from './logging/logger.js';
import { IndicatorService } from './services/IndicatorService.js';
import { KlinesService } from './services/KlinesService.js';
import { MarketFeed } from './services/MarketFeed.js';
import { NewsService } from './services/NewsService.js';
import { ServiceClient } from './services/ServiceClient.js';
import { TradeDispatcher } from './services/TradeDispatcher.js';
import { TradingEngine } from './services/TradingEngine.js';
import { StrategyController } from './strategies/StrategyController.js';

let config;
try {
    config = loadConfig();
} catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
}
setLogLevel(config.logLevel);

const api = new ServiceClient({ baseUrl: config.service.url, apiKey: config.service.apiKey });
const strategy = new StrategyController({
    api,
    klinesService: new KlinesService(api),
    newsService: new NewsService(),
    indicatorService: new IndicatorService(),
    tradeDispatcher: new TradeDispatcher(api, config.trading),
});
const engine = new TradingEngine({ strategy, marketFeed: new MarketFeed(config.service), trading: config.trading });
const actor = createActor({ config, engine, api });

const { port } = await actor.listen();
log.info(`zTraderActor listening on port ${port} (trust proxy hops: ${config.trustProxy})`);
engine.init();

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    setTimeout(() => process.exit(1), 10_000).unref();
    engine.close();
    await actor.close();
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
