import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
    configureApp(app);
    const config = app.get(ConfigService);
    const port = config.get<number>('PORT', 6500);
    await app.listen(port, '0.0.0.0');
    new Logger('Bootstrap').log(
        `zTrader ready on :${port} (${config.get('CTRADER_ACCOUNT_MODE')}, ${config.get('NODE_ENV')})`,
    );
}

void bootstrap();
