import {
    IsString,
    IsEmail,
    IsEnum,
    IsOptional,
    IsNumber,
    IsBoolean,
} from 'class-validator';
import { UserType, UserStatus } from '@prisma/client';

export class CreateUserDto {
    @IsString()
    phone: string;

    @IsString()
    password: string;

    @IsString()
    @IsOptional()
    name?: string;

    @IsEmail()
    @IsOptional()
    email?: string;

    @IsEnum(UserType)
    @IsOptional()
    userType?: UserType;

    @IsEnum(UserStatus)
    @IsOptional()
    status?: UserStatus;

    @IsString()
    @IsOptional()
    realName?: string;

    @IsString()
    @IsOptional()
    idCard?: string;

    @IsString()
    @IsOptional()
    avatar?: string;

    @IsOptional()
    album?: any;

    @IsNumber()
    @IsOptional()
    rating?: number; // 现在关联 StaffRating 的 ID

    @IsNumber()
    @IsOptional()
    level?: number;

    @IsBoolean()
    @IsOptional()
    needResetPwd?: boolean;
}
