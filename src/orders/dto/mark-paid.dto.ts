import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 标记打款
 * - 支持按 settlementIds 批量标记
 * - 或按 period + batchType 查询后标记（v0.1 先实现 settlementIds）
 */
export class MarkPaidDto {
    @IsArray()
    @ArrayMinSize(1)
    @Type(() => Number)
    @IsInt({ each: true })
    settlementIds: number[];

    @IsOptional()
    @IsString()
    remark?: string;
}
