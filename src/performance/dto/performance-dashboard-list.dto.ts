import { IsBoolean, IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

export class PerformanceDashboardListDto {
    @IsOptional()
    @Transform(({ value }) => Number(value ?? 1))
    @IsInt()
    page?: number = 1;

    @IsOptional()
    @Transform(({ value }) => Number(value ?? 20))
    @IsInt()
    limit?: number = 20;

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

    @IsOptional()
    @IsString()
    sortField?: string;

    @IsOptional()
    @IsIn(['ascend', 'descend'])
    sortOrder?: 'ascend' | 'descend';
}