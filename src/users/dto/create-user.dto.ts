import {
    IsString,
    IsEmail,
    IsEnum,
    IsOptional,
    IsNumber,
    IsBoolean, Min,
    IsIn,
    IsDateString,
    IsArray,
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

    /**
     * 押金阈值
     */
    @IsOptional()
    @IsNumber()
    @Min(500)
    depositLimit?: number;

    @IsOptional()
    @IsIn(['ONLINE', 'OFFLINE'])
    workMode?: 'ONLINE' | 'OFFLINE';

    @IsOptional()
    @IsDateString()
    offlineJoinedAt?: string;

    @IsOptional()
    @IsArray()
    staffTags?: string[];
}
