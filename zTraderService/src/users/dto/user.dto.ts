import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { ROLES, type Role } from '../../common/auth/roles';
import { PASSWORD_MAX, PASSWORD_MIN } from '../../auth/password';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

export class CreateUserDto {
    @Transform(lower)
    @IsString()
    @Matches(USERNAME_PATTERN, { message: 'username must be a-z 0-9 . _ - and 3–32 characters long' })
    username!: string;

    @Transform(trim)
    @IsString()
    @Length(1, 80)
    name!: string;

    @IsIn(ROLES)
    role!: Role;

    @IsString()
    @Length(PASSWORD_MIN, PASSWORD_MAX)
    password!: string;
}

export class UpdateUserDto {
    @IsOptional()
    @Transform(trim)
    @IsString()
    @Length(1, 80)
    name?: string;

    @IsOptional()
    @IsIn(ROLES)
    role?: Role;

    @IsOptional()
    @IsBoolean()
    disabled?: boolean;
}

export class ResetPasswordDto {
    @IsString()
    @Length(PASSWORD_MIN, PASSWORD_MAX)
    password!: string;
}

export class UserIdParam {
    @IsString()
    @MaxLength(24)
    @Matches(/^[a-f0-9]{24}$/, { message: 'invalid user id' })
    id!: string;
}
