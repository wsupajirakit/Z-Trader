import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
    ALL_SOURCE_IDS,
    BARS_LIMIT_DEFAULT,
    BARS_LIMIT_MAX,
    BARS_LIMIT_MIN,
    CHART_SYMBOLS,
    CHART_TIMEFRAMES,
    type ChartSymbol,
    type ChartTimeframe,
    normalizeSource,
} from '../chart.constants';

const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export class ChartSymbolQuery {
    @Transform(upper)
    @IsIn(CHART_SYMBOLS, { message: `symbol must be one of: ${CHART_SYMBOLS.join(', ')}` })
    symbol!: ChartSymbol;
}

export class ChartStreamQuery extends ChartSymbolQuery {
    /** the per-symbol check (e.g. tv:VANTAGE exists for XAUUSD only) is done by ChartService */
    @Transform(({ value }) => normalizeSource(value))
    @IsIn(ALL_SOURCE_IDS, { message: 'source is not a known chart source (see /api/chart/sources)' })
    source!: string;

    @Transform(upper)
    @IsIn(CHART_TIMEFRAMES, { message: `tf must be one of: ${CHART_TIMEFRAMES.join(', ')}` })
    tf!: ChartTimeframe;
}

export class ChartBarsQuery extends ChartStreamQuery {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(BARS_LIMIT_MIN)
    @Max(BARS_LIMIT_MAX)
    limit: number = BARS_LIMIT_DEFAULT;
}
