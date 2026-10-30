import { IsObject, IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CreateRiskProfileDto {
    @IsString()
    @Length(1, 40)
    name!: string;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    description?: string;

    /** shape checked by parseProfileValues (nested amounts with units) */
    @IsObject()
    values!: unknown;
}

export class UpdateRiskProfileDto {
    @IsOptional()
    @IsString()
    @Length(1, 40)
    name?: string;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    description?: string;

    @IsOptional()
    @IsObject()
    values?: unknown;
}
