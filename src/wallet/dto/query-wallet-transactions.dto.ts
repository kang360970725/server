import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
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
    orderSerial?: string;
}
