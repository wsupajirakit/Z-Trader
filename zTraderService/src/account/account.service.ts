import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '../common/utils/errors';
import { CtraderService } from '../ctrader/ctrader.service';

export interface AccountSummary {
    available: boolean;
    accountId: number | null;
    mode: string;
    /** account balance in the deposit currency (already divided by 10^moneyDigits) */
    balance: number | null;
    /** the bot's risk settings are in USD; the demo/live accounts used here are USD accounts */
    currency: 'USD';
    leverage: number | null;
    updatedAt: string | null;
    error?: string;
}

type Num = number | { toString(): string } | null | undefined;
const num = (v: Num) => (typeof v === 'number' ? v : Number(v?.toString?.() ?? v ?? 0));

const SPOTWARE_ACCOUNTS_URL = 'https://api.spotware.com/connect/tradingaccounts';

/**
 * Balance of the connected cTrader account, cached briefly. Read from Spotware's account API with the
 * service's own access token (ProtoOATraderRes over the Open API socket does not decode for this
 * account), falling back to the socket when that API is unreachable.
 */
@Injectable()
export class AccountService {
    private readonly logger = new Logger(AccountService.name);
    private cache: { at: number; value: AccountSummary } | null = null;

    constructor(
        private readonly ctrader: CtraderService,
        private readonly config: ConfigService,
    ) {}

    async summary(maxAgeMs = 15_000): Promise<AccountSummary> {
        if (this.cache && Date.now() - this.cache.at < maxAgeMs) return this.cache.value;
        const mode = this.config.get<string>('CTRADER_ACCOUNT_MODE', 'DEMO').toUpperCase();
        const empty: AccountSummary = {
            available: false,
            accountId: this.ctrader.activeAccountId ?? null,
            mode,
            balance: null,
            currency: 'USD',
            leverage: null,
            updatedAt: null,
        };
        if (!this.ctrader.isAuthorized || !this.ctrader.activeAccountId) {
            return { ...empty, error: 'cTrader account is not authorized yet' };
        }
        const value = (await this.fromSpotware(empty)) ?? (await this.fromSocket(empty));
        if (value) {
            this.cache = { at: Date.now(), value };
            return value;
        }
        return { ...empty, error: 'Could not read the account balance from cTrader' };
    }

    private async fromSpotware(empty: AccountSummary): Promise<AccountSummary | null> {
        const token = this.config.get<string>('ACCESS_TOKEN', '').trim();
        if (!token) return null;
        try {
            const res = await fetch(`${SPOTWARE_ACCOUNTS_URL}?access_token=${encodeURIComponent(token)}`, {
                signal: AbortSignal.timeout(8_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
            const acc = (body.data ?? []).find((a) => Number(a.accountId) === Number(this.ctrader.activeAccountId));
            if (!acc || acc.balance == null) return null;
            const digits = acc.moneyDigits != null ? Number(acc.moneyDigits) : 2;
            return {
                ...empty,
                available: true,
                balance: Number(acc.balance) / 10 ** digits,
                leverage: acc.leverageInCents != null ? Number(acc.leverageInCents) / 100 : null,
                updatedAt: new Date().toISOString(),
            };
        } catch (e) {
            this.logger.warn(`Spotware account API: ${errorMessage(e)} — trying the Open API socket`);
            return null;
        }
    }

    private async fromSocket(empty: AccountSummary): Promise<AccountSummary | null> {
        try {
            const res = await this.ctrader.request<any>('ProtoOATraderReq', {
                ctidTraderAccountId: this.ctrader.activeAccountId,
            });
            const t = res?.trader;
            if (!t || t.balance == null) return null;
            const digits = t.moneyDigits != null ? num(t.moneyDigits) : 2;
            return {
                ...empty,
                available: true,
                balance: num(t.balance) / 10 ** digits,
                leverage: t.leverageInCents != null ? num(t.leverageInCents) / 100 : null,
                updatedAt: new Date().toISOString(),
            };
        } catch (e) {
            this.logger.warn(`Could not read the account balance: ${errorMessage(e)}`);
            return null;
        }
    }
}
