import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
    MinLength,
} from 'class-validator';

/** Largest log page zTraderActor serves (its ring buffer holds 500 lines). */
export const MAX_ACTOR_LOG_PAGE = 500;

/**
 * Shape check only. zTraderActor owns the rules (known symbols pattern, known strategy modes, dedupe)
 * and answers 400 with its own message, which is passed through.
 */
export class ActorStartDto {
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(10)
    @IsString({ each: true })
    @Matches(/^[A-Z0-9]{1,20}$/, { each: true, message: 'each symbol must be 1-20 characters of A-Z 0-9' })
    symbols!: string[];

    @IsString()
    @MinLength(1)
    @MaxLength(20)
    mode!: string;
}

export class ActorLogsQuery {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(Number.MAX_SAFE_INTEGER)
    after = 0;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(MAX_ACTOR_LOG_PAGE)
    limit = 200;
}
