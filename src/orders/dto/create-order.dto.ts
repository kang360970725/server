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

    /**
     * 是否已收款（人工确认）
     * - 前端必须显式传递，不从 paymentTime 推断
     * - 先打后付：isPaid=false
     */
    @IsOptional()
    @IsBoolean()
    isPaid?: boolean;

    /**
     * 优惠汇总输入（可选）：
     * - 不传则默认为 0
     * - 先提供总线字段，后续再接完整券引擎
     */
    @IsOptional()
    @IsNumber()
    @Min(0)
    couponDiscountAmount?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    activityDiscountAmount?: number;

    /**
     * 人工调整金额：
     * - >0 代表减免
     * - <0 代表加价（本期先保留字段，前端后续可开放）
     */
    @IsOptional()
    @IsNumber()
    manualAdjustAmount?: number;

    /**
     * 用户券ID（可选）：
     * - 传入后由后端按券模板规则计算优惠金额
     * - 计算成功会自动核销为 USED
     */
    @IsOptional()
    @IsInt()
    userCouponId?: number;

}
