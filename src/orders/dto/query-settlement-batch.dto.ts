import { IsDateString, IsOptional, IsString } from 'class-validator';

/**
 * 批次结算查询
 * - EXPERIENCE_3DAY：体验/福袋（每3个自然日）
 * - MONTHLY_REGULAR：正价月度
 *
 * v0.1：直接用 settledAt 作为统计窗口（结单落库的时间）
 */
export class QuerySettlementBatchDto {
    @IsOptional()
    @IsString()
    batchType?: 'EXPERIENCE_3DAY' | 'MONTHLY_REGULAR';

    @IsOptional()
    @IsDateString()
    periodStart?: string;

    @IsOptional()
    @IsDateString()
    periodEnd?: string;
}
