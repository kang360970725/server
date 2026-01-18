import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class ReconcileOrdersDto {
    @IsString()
    startAt!: string;

    @IsString()
    endAt!: string;

    /** 分页：从 1 开始 */
    @IsOptional()
    @IsNumber()
    @Min(1)
    page?: number;

    @IsOptional()
    @IsNumber()
    @Min(1)
    pageSize?: number;

    /** 订单编号：Order.autoSerial（精确匹配；你需要模糊的话后面再加 contains） */
    @IsOptional()
    @IsString()
    autoSerial?: string;

    /** 打手ID（按参与结算的 userId 过滤订单） */
    @IsOptional()
    @IsNumber()
    @Min(1)
    playerId?: number;

    /** 是否包含赠送单（默认 false） */
    @IsOptional()
    @IsBoolean()
    includeGifted?: boolean;

    /**
     * 仅看异常单（可选）：
     * - true：只返回“支出>收入 / 已退款但未冲正 / 未付款但有结算”等异常
     * - false/不传：全部
     */
    @IsOptional()
    @IsBoolean()
    onlyAbnormal?: boolean;
}
