import { IsBoolean, IsIn, IsInt, IsNumberString, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class PerformanceDashboardOverviewDto {
    @IsOptional()
    @IsString()
    dateFrom?: string;

    @IsOptional()
    @IsString()
    dateTo?: string;

    @IsOptional()
    @IsIn(['HOURLY', 'GUARANTEED', 'MODE_PLAY'])
    billingMode?: 'HOURLY' | 'GUARANTEED' | 'MODE_PLAY';

    @IsOptional()
    @Transform(({ value }) => {
        if (value === '' || value === null || value === undefined) return undefined;
        if (typeof value === 'boolean') return value;
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
    })
    @IsBoolean()
    isExperience?: boolean;

    @IsOptional()
    @IsIn(['STAFF', 'CUSTOMER_SERVICE', 'ALL'])
    userType?: 'STAFF' | 'CUSTOMER_SERVICE' | 'ALL';

    @IsOptional()
    @IsString()
    keyword?: string;

    @IsOptional()
    @Transform(({ value }) => {
        if (value === '' || value === null || value === undefined) return undefined;
        return Number(value);
    })
    @IsInt()
    clubId?: number;
}