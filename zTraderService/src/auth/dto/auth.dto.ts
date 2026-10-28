import { IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { PASSWORD_MAX, PASSWORD_MIN } from '../password';

export class LoginDto {
    @IsString()
    @Length(1, 64)
    username!: string;

    @IsString()
    @Length(1, PASSWORD_MAX)
    password!: string;
}

export class ChangePasswordDto {
    @IsString()
    @Length(1, PASSWORD_MAX)
    currentPassword!: string;

    @IsString()
    @Length(PASSWORD_MIN, PASSWORD_MAX)
    newPassword!: string;
}

/** zTraderActor forwards its user's login here (machine route, x-api-key) */
export class VerifyCredentialsDto extends LoginDto {
    @IsOptional()
    @IsString()
    @MaxLength(64)
    clientIp?: string;

    @IsOptional()
    @IsString()
    @MaxLength(300)
    userAgent?: string;
}

export class SessionIdParam {
    @IsString()
    @Length(1, 32)
    id!: string;
}
