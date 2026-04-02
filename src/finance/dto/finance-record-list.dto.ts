import {
    IsBoolean,
    IsDateString,
    IsInt,
    IsOptional,
    IsString,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

function toBoolean(value: any) {
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return undefined;
}

export class FinanceRecordListDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    page?: number = 1;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    pageSize?: number = 20;

    @IsOptional()
    @IsDateString()
    startDate?: string;

    @IsOptional()
    @IsDateString()
    endDate?: string;

    @IsOptional()
    @IsString()
    billingMode?: string;

    @IsOptional()
    @IsString()
    orderType?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    projectId?: number;

    @IsOptional()
    @IsString()
    bizLine?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    customerUserId?: number;

    @IsOptional()
    @Transform(({ value }) => toBoolean(value))
    @IsBoolean()
    isComplained?: boolean;

    @IsOptional()
    @Transform(({ value }) => toBoolean(value))
    @IsBoolean()
    isAfterSale?: boolean;

    @IsOptional()
    @Transform(({ value }) => toBoolean(value))
    @IsBoolean()
    isCancelled?: boolean;

    @IsOptional()
    @IsString()
    status?: string;
}