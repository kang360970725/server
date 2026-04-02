import { IsDateString, IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class FinanceDashboardTrendDto {
    @IsIn(['DAY', 'MONTH'])
    groupBy: 'DAY' | 'MONTH';

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
}