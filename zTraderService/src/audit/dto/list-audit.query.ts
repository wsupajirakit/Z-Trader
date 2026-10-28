import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** `<ISO date>_<24-hex id>` as returned in `nextBefore`, or a bare ISO date (older clients, hand-written queries) */
export const AUDIT_CURSOR = /^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?(_[0-9a-f]{24})?$/i;

export class ListAuditQuery {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(200)
    limit = 50;

    @IsOptional()
    @IsString()
    @MaxLength(64)
    @Matches(AUDIT_CURSOR, { message: 'before must be the nextBefore value of a previous page, or an ISO date' })
    before?: string;
}
