// src/auth/dto/register.dto.ts
import { IsPhoneNumber, IsString, MinLength, IsOptional, IsEnum } from 'class-validator';
import { UserType } from '@prisma/client';

export class RegisterDto {
    @IsPhoneNumber('CN')
    phone: string;

    @IsString()
    @MinLength(6)
    password: string;

    @IsString()
    @IsOptional()
    name?: string;

    @IsEnum(UserType)
    @IsOptional()
    userType?: UserType;

    @IsString()
    @IsOptional()
    email?: string;

    @IsString()
    @IsOptional()
    realName?: string;

    @IsString()
    @IsOptional()
    idCard?: string;

    @IsString()
    @IsOptional()
    avatar?: string;
}
