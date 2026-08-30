import {
    IsInt,
    IsNumber,
    IsOptional,
    IsString,
    IsDateString,
    Min,
    IsBoolean, // ✅ 新增
    IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';

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

    @IsOptional()
    @IsNumber()
    @Min(0)
    settlementAmount?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    settlementBaseAmount?: number;

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
    @IsString()
    customerIdentifierType?: string;

    @IsOptional()
    @IsString()
    customerOriginalIdentifier?: string;

    @IsOptional()
    @IsInt()
    customerUserId?: number;

    @IsOptional()
    @IsString()
    orderSource?: string;

    @IsOptional()
    @IsString()
    paymentChannel?: string;

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

    /**
     * 是否续单：
     * - 只能在创建订单并首轮派单时设置
     * - 开启后推荐人失效
     */
    @IsOptional()
    @IsBoolean()
    isRenewal?: boolean;

    /**
     * 续单归属打手：
     * - 必须是本次创建订单传入 playerIds 的子集
     * - 多人时榜单按组合维度统计，分红按人均分
     */
    @IsOptional()
    @IsArray()
    @Type(() => Number)
    @IsInt({ each: true })
    renewalPlayerIds?: number[];

    /**
     * 是否指定：
     * - 与续单二选一，不可同时存在
     * - 分红规则复用续单规则，但指定成员不受优秀服务者名单限制
     */
    @IsOptional()
    @IsBoolean()
    isDesignated?: boolean;

    /**
     * 指定归属服务者：
     * - 必须是本次创建订单传入 playerIds 的子集
     */
    @IsOptional()
    @IsArray()
    @Type(() => Number)
    @IsInt({ each: true })
    designatedPlayerIds?: number[];

}
