import { IsOptional, IsString } from 'class-validator';

/**
 * 营业额看板查询参数（全平台）
 * - 时间口径：Order.createdAt
 */
export class QueryRevenueOverviewDto {
    /** ISO string，如 2026-01-01T00:00:00.000Z */
    @IsOptional()
    @IsString()
    startAt?: string;

    /** ISO string，如 2026-01-31T23:59:59.999Z */
    @IsOptional()
    @IsString()
    endAt?: string;

    // 预留：后续按门店/项目筛选（先不实现）
    @IsOptional()
    @IsString()
    storeId?: string;

    @IsOptional()
    @IsString()
    projectId?: string;
}
