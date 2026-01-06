import {
    IsInt,
    IsNumber,
    IsOptional,
    IsString,
    IsDateString,
    Min,
    IsBoolean, // ✅ 新增
} from 'class-validator';

/**
 * 创建订单 DTO（v0.1）
 * - 金额手填（你确认 Q1=A）
 * - 项目必选
 * - projectSnapshot 在 service 内生成
 */
export class CreateOrderDto {
    @IsInt()
    projectId: number;

    @IsNumber()
    @Min(0)
    receivableAmount: number;

    @IsNumber()
    @Min(0)
    paidAmount: number;

    @IsNumber()
    @Min(1)
    orderQuantity: number;

    @IsOptional()
    @IsDateString()
    orderTime?: string;

    @IsOptional()
    @IsDateString()
    paymentTime?: string;

    @IsOptional()
    @IsNumber()
    @Min(0)
    baseAmountWan?: number;

    @IsOptional()
    @IsString()
    customerGameId?: string;

    @IsOptional()
    @IsNumber()
    csRate?: number; // 默认：非体验单 0.01，体验单 0

    @IsOptional()
    @IsNumber()
    inviteRate?: number; // 默认：有 inviter 时 0.05，否则 0

    @IsOptional()
    @IsString()
    inviter?: string;

    @IsOptional()
    @IsNumber()
    customClubRate?: number; // 订单级俱乐部抽成（确认：这就是俱乐部抽成）

    /**
     * 是否赠送单：
     * - 赠送单不收款（后端会强制把 receivableAmount/paidAmount 置 0）
     * - 仍正常结算/分红（结单逻辑不变）
     * - 日账单/营收统计需排除（后续我们在统计接口里做排除）
     */
    @IsOptional()
    @IsBoolean()
    isGifted?: boolean;
}
