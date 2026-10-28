/**
 * Create a dashboard user from the command line (first admin, or recovery when every admin is locked out).
 *
 *   node dist/cli/create-user.js --username alice --role admin [--name "Alice"] [--no-force-change]
 *
 * The password is read from the terminal without echo, or from the first line of stdin when piped, so it
 * never appears in shell history or `ps`.
 */
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { parseArgs } from 'util';
import { createInterface } from 'readline';
import { ROLES, type Role } from '../common/auth/roles';
import { errorMessage } from '../common/utils/errors';
import { UsersModule } from '../users/users.module';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MongooseModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (c: ConfigService) => ({ uri: c.getOrThrow<string>('MONGO_URI') }),
        }),
        UsersModule,
    ],
})
class CliModule {}

async function readPassword(prompt: string): Promise<string> {
    if (!process.stdin.isTTY) {
        const rl = createInterface({ input: process.stdin });
        for await (const line of rl) return line;
        return '';
    }
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    return new Promise((resolve, reject) => {
        const onData = (buf: Buffer) => {
            for (const ch of buf.toString('utf8')) {
                if (ch === '\r' || ch === '\n') {
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.off('data', onData);
                    process.stdout.write('\n');
                    return resolve(value);
                }
                if (ch === '\u0003') return reject(new Error('cancelled'));
                if (ch === '\u007f') value = value.slice(0, -1);
                else value += ch;
            }
        };
        stdin.on('data', onData);
    });
}

async function main() {
    const { values } = parseArgs({
        options: {
            username: { type: 'string' },
            name: { type: 'string' },
            role: { type: 'string', default: 'viewer' },
            'no-force-change': { type: 'boolean', default: false },
        },
    });
    if (!values.username || !ROLES.includes(values.role as Role)) {
        console.error(
            `usage: create-user --username <name> --role <${ROLES.join('|')}> [--name "Display Name"] [--no-force-change]`,
        );
        process.exit(2);
    }
    const password = await readPassword('password: ');
    if (process.stdin.isTTY && (await readPassword('repeat:   ')) !== password) {
        console.error('passwords do not match');
        process.exit(2);
    }

    const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
    try {
        const user = await app.get(UsersService).create({
            username: values.username,
            name: values.name ?? values.username,
            role: values.role as Role,
            password,
            mustChangePassword: !values['no-force-change'],
        });
        await app.get(AuditService).record({
            actor: null,
            action: 'user.create_cli',
            target: user.username,
            ip: 'cli',
            success: true,
            detail: { role: user.role },
        });
        console.log(
            `created ${user.role} "${user.username}"${user.mustChangePassword ? ' (must change password at first login)' : ''}`,
        );
    } catch (e) {
        console.error(`failed: ${errorMessage(e)}`);
        process.exitCode = 1;
    } finally {
        await app.close();
    }
}

void main();
