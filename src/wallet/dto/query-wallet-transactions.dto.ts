import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * 钱包流水查询参数（管理端当前用户）
 * - GET /wallet/transactions
 */
export class QueryWalletTransactionsDto {
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

    @IsOptional()
    @IsString()
    bizType?: string;

    /**
     * 是否包含解冻流水（RELEASE_FROZEN）
     * - 默认 false（不传即排除）
     * - 仅在未指定 bizType 时生效
     */
    @IsOptional()
    @Transform(({ value }) => {
        if (value === true || value === false) return value;
        const v = String(value ?? '').trim().toLowerCase();
        if (v === 'true' || v === '1' || v === 'yes') return true;
        if (v === 'false' || v === '0' || v === 'no') return false;
        return false;
    })
    @IsBoolean()
    includeReleaseFrozen?: boolean;

    @IsOptional()
    @IsIn(['IN', 'OUT'])
    direction?: 'IN' | 'OUT';

    @IsOptional()
    @Transform(({ value }) => Number(value))
    @IsInt()
    orderId?: number;

    @IsOptional()
    @Transform(({ value }) => Number(value))
    @IsInt()
    dispatchId?: number;

    /** ISO string */
    @IsOptional()
    @IsString()
    startAt?: string;

    /** ISO string */
    @IsOptional()
    @IsString()
    endAt?: string;

    // ✅ 新增：订单编号（Order.autoSerial）模糊查询
    orderAutoSerial?: string;

    @IsOptional()
    @IsInt()
    userId?: number;
}
