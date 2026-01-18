import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class ReconcileSummaryDto {
    /** 收款时间开始：ISO 字符串 */
    @IsString()
    startAt!: string;

    /** 收款时间结束：ISO 字符串 */
    @IsString()
    endAt!: string;

    /**
     * 是否包含赠送单：
     * - 默认 false：赠送单不计入营收统计（你 schema 注释也明确要求排除）
     */
    @IsOptional()
    @IsBoolean()
    includeGifted?: boolean;
}
