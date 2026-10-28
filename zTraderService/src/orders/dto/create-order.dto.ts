import {
    IsIn,
    IsInt,
    IsNumber,
    IsOptional,
    IsPositive,
    IsString,
    Length,
    Matches,
    Max,
    MaxLength,
} from 'class-validator';

/**
 * Body of `POST /orders` (zTraderActor). Every field the execution path reads is declared here; the
 * global ValidationPipe rejects anything else, so a caller cannot smuggle extra ProtoOA fields through.
 * There is deliberately no `unitsPerLot`: the lot size comes from the symbol, never from the caller
 * (an unbounded value would multiply the real position size).
 */
export class CreateOrderDto {
    /** idempotency key — a repeat with the same uuid gets 409 instead of a second order */
    @IsString()
    @Length(8, 100)
    @Matches(/^[A-Za-z0-9_-]+$/)
    uuid!: string;

    /** optional (null = not sent), but if sent it must be the account this service is authorised for */
    @IsOptional()
    @IsInt()
    @IsPositive()
    accountId?: number;

    @IsString()
    @Matches(/^[A-Z0-9._]{3,20}$/)
    symbol!: string;

    @IsOptional()
    @IsInt()
    @IsPositive()
    symbolId?: number;

    /** lots */
    @IsNumber({ maxDecimalPlaces: 2 })
    @IsPositive()
    @Max(100)
    volume!: number;

    @IsIn(['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'])
    orderType!: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';

    @IsIn(['BUY', 'SELL'])
    side!: 'BUY' | 'SELL';

    @IsOptional()
    @IsNumber()
    @IsPositive()
    price?: number;

    @IsOptional()
    @IsNumber()
    @IsPositive()
    stopLoss?: number;

    @IsOptional()
    @IsNumber()
    @IsPositive()
    takeProfit?: number;

    @IsOptional()
    @IsInt()
    @IsPositive()
    relativeStopLoss?: number;

    @IsOptional()
    @IsInt()
    @IsPositive()
    relativeTakeProfit?: number;

    @IsOptional()
    @IsInt()
    @IsPositive()
    expirationTimestamp?: number;

    @IsOptional()
    @IsString()
    @MaxLength(40)
    mode?: string;

    @IsOptional()
    @IsString()
    @MaxLength(100)
    comment?: string;
}
