import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { INSTRUMENT_KEYS } from '../../gold/domain/instruments';

/** GET /api/dashboard/trades?status=all&limit=200&before=<ms> */
export class TradesQuery {
    @IsOptional()
    @IsIn(['open', 'closed', 'all'])
    status: 'open' | 'closed' | 'all' = 'all';

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(500)
    limit = 200;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    before?: number;
}

/** GET /api/dashboard/quotes/stream?symbols=EURUSD,XAUUSD */
export class QuotesStreamQuery {
    @Transform(({ value }: { value: unknown }) =>
        typeof value === 'string'
            ? [
                  ...new Set(
                      value
                          .split(',')
                          .map((s) => s.trim().toUpperCase())
                          .filter(Boolean),
                  ),
              ]
            : value,
    )
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(INSTRUMENT_KEYS.length)
    @IsIn(INSTRUMENT_KEYS, { each: true })
    symbols!: string[];
}
