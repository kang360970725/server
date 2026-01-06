import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * 冻结单查询参数（管理端当前用户）
 * - GET /wallet/holds
 */
export class QueryWalletHoldsDto {
    @IsOptional()
    @Transform(({ value }) => Number(value))
    @IsInt()
    @Min(1)
    page?: number;

    @IsOptional()
    @Transform(({ value }) => Number(value))
    @IsInt()
    @Min(1)
    limit?: number;

    @IsOptional()
    @IsString()
    status?: string;
}
