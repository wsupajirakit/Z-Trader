/**
 * Boots the real AppModule from dist/ against a throwaway MongoDB (mongodb-memory-server, or
 * TEST_MONGO_URI when set), with the same configureApp() that main.ts uses.
 *
 * One app per test file: ConfigModule reads the environment once, when the module is first loaded,
 * so scenarios that need a different env (TRUST_PROXY, rate limits) live in their own file. Node's
 * test runner already gives every file its own process. Suites inside a file call resetData().
 *
 * Isolation: NODE_ENV=test makes ConfigModule ignore any local .env, cTrader points at a closed local
 * port, and Telegram/AI keys are blanked, so no test can reach a broker, a chat or a paid API.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';

const require = createRequire(import.meta.url);
const DIST = resolve(import.meta.dirname, '../../../dist');

export const API_KEY = 'test-api-key-0123456789abcdef0123456789abcdef';
export const ADMIN = { username: 'root', password: 'Bootstrap-Pass-5678' };

export interface TestApp {
    app: INestApplication;
    server: import('node:http').Server;
    get<T>(token: string): T;
    /** empty every collection, forget rate-limit counters and re-create the bootstrap admin */
    resetData(): Promise<void>;
    /** forget every rate-limit counter, so a test can count requests from zero */
    resetThrottle(): void;
    /** the raw MongoDB collection, for asserting on stored state the API does not expose */
    collection(name: string): RawCollection;
    close(): Promise<void>;
}

/** the few native driver calls the suites use (mongodb itself is only a transitive dependency) */
export interface RawCollection {
    countDocuments(filter: object): Promise<number>;
    findOne(filter: object): Promise<Record<string, any> | null>;
    insertMany(docs: object[]): Promise<unknown>;
}

let started = false;

export async function startApp(extraEnv: Record<string, string> = {}): Promise<TestApp> {
    if (started) throw new Error('startApp() may run once per test file (ConfigModule caches the env)');
    started = true;
    const mongo = process.env.TEST_MONGO_URI ? null : await MongoMemoryServer.create();
    const dbName = `zt_e2e_${process.pid}_${Date.now()}`;
    const uri = process.env.TEST_MONGO_URI
        ? `${process.env.TEST_MONGO_URI.replace(/\/$/, '')}/${dbName}`
        : mongo!.getUri(dbName);
    const scratch = mkdtempSync(join(tmpdir(), 'zt-e2e-'));

    Object.assign(process.env, {
        NODE_ENV: 'test',
        MONGO_URI: uri,
        API_KEY,
        CTRADER_ACCOUNT_MODE: 'DEMO',
        CTRADER_HOST: '127.0.0.1',
        CTRADER_PORT: '9',
        APP_ID: '',
        APP_SECRET: '',
        ACCESS_TOKEN: '',
        DEMO_ACCOUNT_ID: '',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
        GEMINI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        GOLD_AUTOMATE_ENABLED: 'false',
        GOLD_ARCHIVE_DIR: join(scratch, 'archive'),
        GOLD_SETTINGS_FILE: join(scratch, 'runtime-settings.json'),
        WEB_DIST_DIR: join(scratch, 'no-web'),
        BOOTSTRAP_ADMIN_USERNAME: ADMIN.username,
        BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        TRUST_PROXY: '0',
        // suites log in many times; the brute-force suite lowers this back to the production value
        LOGIN_RATE_LIMIT_PER_MIN: '1000',
        ...extraEnv,
    });

    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require(join(DIST, 'app.module.js'));
    const { configureApp } = require(join(DIST, 'app.setup.js'));
    const app: INestApplication = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error'] });
    configureApp(app);
    try {
        await app.init();
    } catch (e) {
        // a half-started app keeps sockets and timers alive and would hang the runner
        await app.close().catch(() => undefined);
        await mongo?.stop();
        rmSync(scratch, { recursive: true, force: true });
        throw e;
    }
    const { ExecutionService } = require(join(DIST, 'execution/execution.service.js'));
    // order intake is under test, not the broker round-trip (there is no broker here)
    app.get<{ executeOrder: () => Promise<void> }>(ExecutionService).executeOrder = () => Promise.resolve();

    const get = <T,>(path: string): T => {
        const [file, name] = path.split('#');
        return app.get<T>(require(join(DIST, file))[name]);
    };
    const { getConnectionToken } = require('@nestjs/mongoose');
    const connection = app.get<{
        collections: Record<string, { deleteMany(f: object): Promise<unknown> }>;
        db: { collection(name: string): RawCollection };
    }>(getConnectionToken());
    const resetThrottle = () => {
        const { getStorageToken } = require('@nestjs/throttler');
        // the in-memory storage has no public reset; its shutdown hook empties both of its maps
        app.get<{ onApplicationShutdown(): void }>(getStorageToken()).onApplicationShutdown();
    };
    return {
        app,
        server: app.getHttpServer(),
        get,
        resetThrottle,
        collection: (name) => connection.db.collection(name),
        resetData: async () => {
            for (const c of Object.values(connection.collections)) await c.deleteMany({});
            resetThrottle();
            await get<{ onApplicationBootstrap(): Promise<void> }>(
                'auth/auth.service.js#AuthService',
            ).onApplicationBootstrap();
        },
        close: async () => {
            await app.close();
            await mongo?.stop();
            rmSync(scratch, { recursive: true, force: true });
        },
    };
}
