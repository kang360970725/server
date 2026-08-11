import {BadRequestException, ConflictException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';
import {CreateOrderDto} from './dto/create-order.dto';
import {AcceptDispatchDto} from './dto/accept-dispatch.dto';
import {MarkPaidDto} from './dto/mark-paid.dto';
import {
    BillingMode,
    CouponScope,
    CouponTemplateStatus,
    CouponTemplateType,
    DispatchStatus,
    OrderStatus,
    OrderPayStatus,
    OrderType,
    PaymentStatus,
    PlayerWorkStatus,
    UserCouponStatus,
    UserType,
    WalletBizType,
    WalletDirection,
    WalletTxStatus,
    MemberPointBizType,
    MemberPointDirection
} from '@prisma/client';
import {WalletService} from '../wallet/wallet.service';
import {randomInt, randomUUID} from 'crypto';
import {groupByUserId, round2, roundMix1, toNum} from "../utils/money/format";
import {
    computeBillingGuaranteed,
    computeBillingHours,
    computeBillingMODEPLAY
} from "../utils/orderDispatches/revenueInit";
import {compareSettlementsToPlan} from "../utils/finance/generateRepairPlan";
import {computeSettlementFreezeTime} from "../utils/orderDispatches/settlement-freeze.rule";
import { NotificationsService } from '../notifications/notifications.service';
import { MiniSubscribeMessageService } from '../notifications/mini-subscribe-message.service';
import { PenaltiesService } from '../penalties/penalties.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { StaffRuleEngineService } from '../system-config/staff-rule-engine.service';
import { WechatPayService } from '../mini/wechat-pay.service';

type OrderCreateScene = 'ADMIN' | 'MINIAPP' | 'OFFICIAL_ACCOUNT';
type CreateOrderContext = {
    scene?: OrderCreateScene;
    dispatcherId?: number | null;
    customerUserId?: number | null;
};
type AssignDispatchOptions = {
    updateOrderDispatcherId?: boolean;
    writeOperatorLog?: boolean;
    renewalPlayerIds?: number[];
    renewalCreatedBy?: number;
};
type ArchiveDispatchOptions = {
    forceByAdmin?: boolean;
};

type RenewalConfirmMode = 'SETTLE' | 'INVALIDATE';

const ORDER_SOURCE_DEFAULTS = [
    { value: 'TUTU_PLATFORM', label: '突突平台', enabled: true },
    { value: 'THIRD_PARTY_TRANSFER', label: '第三方转单', enabled: true },
    { value: 'MINIAPP_SELF_SERVICE', label: '小程序自助下单', enabled: true },
    { value: 'CUSTOMER_SERVICE_MANUAL', label: '客服手动派单', enabled: true },
    { value: 'OFFICIAL_ACCOUNT', label: '公众号下单', enabled: true },
];

@Injectable()
export class OrdersService {
    private readonly logger = new Logger(OrdersService.name);

  constructor(
        private prisma: PrismaService,
        private wallet: WalletService,
        private notificationsService: NotificationsService,
        private miniSubscribeMessageService: MiniSubscribeMessageService,
        private penaltiesService: PenaltiesService,
        private systemConfigService: SystemConfigService,
        private staffRuleEngineService: StaffRuleEngineService,
        private wechatPayService: WechatPayService,
  ) {
  }

    private normalizeRequiredRemark(input: any, message = '请填写处理原因') {
        const remark = String(input || '').trim();
        if (!remark) {
            throw new BadRequestException(message);
        }
        return remark;
    }

    private buildMemberCode(userId: number) {
        return `BM${String(userId).padStart(8, '0')}`;
    }

    private getOrderRewardPointsByPaidAmount(paidAmount: number) {
        return Math.max(0, Math.floor(round2(Math.max(0, Number(paidAmount || 0))) / 10));
    }

    private getMemberGrowthValueByPaidAmount(paidAmount: number) {
        return Math.max(0, Math.floor(round2(Math.max(0, Number(paidAmount || 0)))));
    }

    private resolveMemberBenefitBaseAmount(order: any, paidAmountInput?: number) {
        const actualPaidAmount = round2(Math.max(0, Number(
            paidAmountInput ?? order?.paidAmount ?? 0,
        )));
        const finalPayableAmount = round2(Math.max(0, Number(
            order?.finalPayableAmount ?? order?.receivableAmount ?? actualPaidAmount,
        )));

        // 仅明确标记为测试支付的订单，才按业务订单金额累计会员权益。
        if (Boolean(order?.isTestPayment) && finalPayableAmount > 0) {
            return finalPayableAmount;
        }

        return actualPaidAmount;
    }

    private buildOrderBalanceReceiptMeta(params: {
        deductedAmount: number;
        balanceAfter: number;
        rewardPoints: number;
        growthValue: number;
    }) {
        return {
            receiptMeta: {
                memberBalanceDeducted: this.toAmount2(Number(params.deductedAmount || 0)),
                memberBalanceAfter: this.toAmount2(Number(params.balanceAfter || 0)),
                rewardPointsPreview: Math.max(0, Number(params.rewardPoints || 0)),
                growthValuePreview: Math.max(0, Number(params.growthValue || 0)),
            },
        };
    }

    private async resolveMemberLevelCodeTx(
        tx: any,
        totalRechargeAmount: number,
        annualContribution: number,
        fallbackLevelCode = 'NONE',
    ) {
        const configs = await tx.memberLevelConfig.findMany({
            where: { enabled: true },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        });

        if (!configs.length) return fallbackLevelCode;

        let matched = configs.find((item: any) => item.isDefault) || configs[0];
        for (const config of configs) {
            if (
                totalRechargeAmount >= Number(config?.minRechargeAmount || 0) &&
                annualContribution >= Number(config?.minAnnualContribution || 0)
            ) {
                matched = config;
            }
        }
        return String(matched?.code || fallbackLevelCode || 'NONE');
    }

    private async applyOrderMemberBenefitsTx(tx: any, order: any) {
        const userId = Number(order?.userId || order?.customerUserId || 0);
        if (!userId) return;

        const benefitBaseAmount = this.resolveMemberBenefitBaseAmount(order);
        if (benefitBaseAmount <= 0) return;

        const growthValue = this.getMemberGrowthValueByPaidAmount(benefitBaseAmount);
        const earnedPoints = this.getOrderRewardPointsByPaidAmount(benefitBaseAmount);

        const currentProfile = await tx.memberProfile.findUnique({ where: { userId } });
        const totalRechargeAmount = Number(currentProfile?.totalRechargeAmount || 0);
        const nextTotalConsumeAmount = round2(Number(currentProfile?.totalConsumeAmount || 0) + benefitBaseAmount);
        const nextAnnualContribution = Number(currentProfile?.annualContribution || 0) + growthValue;
        const nextLevelCode = await this.resolveMemberLevelCodeTx(
            tx,
            totalRechargeAmount,
            nextAnnualContribution,
            String(currentProfile?.levelCode || 'NONE'),
        );

        if (currentProfile) {
            await tx.memberProfile.update({
                where: { userId },
                data: {
                    totalConsumeAmount: nextTotalConsumeAmount,
                    annualContribution: nextAnnualContribution,
                    levelCode: nextLevelCode,
                },
            });
        } else {
            await tx.memberProfile.create({
                data: {
                    userId,
                    memberCode: this.buildMemberCode(userId),
                    levelCode: nextLevelCode,
                    totalConsumeAmount: nextTotalConsumeAmount,
                    annualContribution: nextAnnualContribution,
                },
            });
        }

        if (earnedPoints <= 0) return;

        const existingPointTx = await tx.memberPointTransaction.findFirst({
            where: {
                userId,
                bizType: MemberPointBizType.ORDER_CONSUME,
                sourceType: 'ORDER',
                sourceId: Number(order.id),
            },
            select: { id: true },
        });
        if (existingPointTx) return;

        const pointAccount = await tx.memberPointAccount.upsert({
            where: { userId },
            update: {
                availablePoints: { increment: earnedPoints },
                totalEarnedPoints: { increment: earnedPoints },
            },
            create: {
                userId,
                availablePoints: earnedPoints,
                totalEarnedPoints: earnedPoints,
            },
        });

        await tx.memberPointTransaction.create({
            data: {
                userId,
                direction: MemberPointDirection.IN,
                bizType: MemberPointBizType.ORDER_CONSUME,
                points: earnedPoints,
                balanceAfter: Number(pointAccount.availablePoints),
                sourceType: 'ORDER',
                sourceId: Number(order.id),
                remark: `订单完成奖励积分 ${earnedPoints}（累计口径 ¥${benefitBaseAmount.toFixed(2)}）`,
            },
        });
    }

    private async rollbackOrderMemberBenefitsTx(tx: any, order: any, refundAmountInput?: number) {
        const userId = Number(order?.userId || order?.customerUserId || 0);
        if (!userId) return;

        const paidAmount = round2(Math.max(0, Number(order?.paidAmount || 0)));
        const benefitOrderBaseAmount = this.resolveMemberBenefitBaseAmount(order, paidAmount);
        const benefitBaseAmount = round2(Math.min(
            benefitOrderBaseAmount,
            Math.max(0, Number((refundAmountInput ?? paidAmount) || 0)) >= paidAmount && paidAmount > 0
                ? benefitOrderBaseAmount
                : Math.max(0, Number((refundAmountInput ?? paidAmount) || 0)),
        ));
        if (benefitBaseAmount <= 0) return;

        const growthValue = this.getMemberGrowthValueByPaidAmount(benefitBaseAmount);
        const earnedPoints = this.getOrderRewardPointsByPaidAmount(benefitBaseAmount);

        const currentProfile = await tx.memberProfile.findUnique({ where: { userId } });
        if (currentProfile) {
            const totalRechargeAmount = Number(currentProfile?.totalRechargeAmount || 0);
            const nextTotalConsumeAmount = Math.max(0, round2(Number(currentProfile?.totalConsumeAmount || 0) - benefitBaseAmount));
            const nextAnnualContribution = Math.max(0, Number(currentProfile?.annualContribution || 0) - growthValue);
            const nextLevelCode = await this.resolveMemberLevelCodeTx(
                tx,
                totalRechargeAmount,
                nextAnnualContribution,
                String(currentProfile?.levelCode || 'NONE'),
            );

            await tx.memberProfile.update({
                where: { userId },
                data: {
                    totalConsumeAmount: nextTotalConsumeAmount,
                    annualContribution: nextAnnualContribution,
                    levelCode: nextLevelCode,
                },
            });
        }

        if (earnedPoints <= 0) return;

        const rewardPointTx = await tx.memberPointTransaction.findFirst({
            where: {
                userId,
                bizType: MemberPointBizType.ORDER_CONSUME,
                sourceType: 'ORDER',
                sourceId: Number(order.id),
            },
            orderBy: { id: 'desc' },
            select: { id: true },
        });
        if (!rewardPointTx) return;

        const existingRollbackTx = await tx.memberPointTransaction.findFirst({
            where: {
                userId,
                bizType: MemberPointBizType.ORDER_DEDUCT,
                sourceType: 'ORDER_REFUND',
                sourceId: Number(order.id),
            },
            select: { id: true },
        });
        if (existingRollbackTx) return;

        const pointAccount = await tx.memberPointAccount.upsert({
            where: { userId },
            update: {
                availablePoints: { decrement: earnedPoints },
                totalSpentPoints: { increment: earnedPoints },
            },
            create: {
                userId,
                availablePoints: 0 - earnedPoints,
                totalSpentPoints: earnedPoints,
            },
        });

        await tx.memberPointTransaction.create({
            data: {
                userId,
                direction: MemberPointDirection.OUT,
                bizType: MemberPointBizType.ORDER_DEDUCT,
                points: earnedPoints,
                balanceAfter: Number(pointAccount.availablePoints),
                sourceType: 'ORDER_REFUND',
                sourceId: Number(order.id),
                remark: `订单退款扣回积分 ${earnedPoints}（退款 ¥${benefitBaseAmount.toFixed(2)}）`,
            },
        });
    }

    private getDispatchParticipantUserSelect() {
        return {
            id: true,
            name: true,
            phone: true,
            avatar: true,
            workStatus: true,
            userType: true,
            staffRating: {
                select: {
                    id: true,
                    name: true,
                    rate: true,
                },
            },
        };
    }

    private isOrderEffectivelyPaidOrGifted(order: { isPaid?: boolean | null; isGifted?: boolean | null; payStatus?: OrderPayStatus | string | null }) {
        return Boolean(order?.isGifted) || order?.isPaid === true || String(order?.payStatus || '') === OrderPayStatus.SUCCESS;
    }

    private getAutoConfirmAnchorAt(order: { dispatches?: Array<{ completedAt?: Date | string | null }>; updatedAt?: Date | string | null }) {
        const completedAtList = Array.isArray(order?.dispatches)
            ? order.dispatches
                .map((d) => (d?.completedAt ? new Date(d.completedAt) : null))
                .filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()))
            : [];

        if (completedAtList.length) {
            return completedAtList.sort((a, b) => a.getTime() - b.getTime())[completedAtList.length - 1];
        }

        const updatedAt = order?.updatedAt ? new Date(order.updatedAt) : null;
        return updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt : null;
    }

    private async lockOrderForSettlement(tx: any, orderId: number) {
        await tx.$queryRawUnsafe(`SELECT id FROM \`Order\` WHERE id = ? FOR UPDATE`, Number(orderId));
    }

    /**
     * 根据“仍在进行中的有效接单”刷新打手工作状态。
     * - 存在有效已接单：WORKING
     * - 否则：IDLE
     */
    private async refreshPlayerWorkStatusByActiveAcceptedDispatches(tx: any, userIds: number[]) {
        const uniqUserIds = Array.from(new Set((userIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)));
        if (!uniqUserIds.length) return;

        for (const userId of uniqUserIds) {
            const activeAcceptedCount = await tx.orderParticipant.count({
                where: {
                    userId,
                    isActive: true,
                    rejectedAt: null,
                    acceptedAt: { not: null },
                    dispatch: {
                        status: { in: [DispatchStatus.ACCEPTED, DispatchStatus.SETTLING] },
                    },
                },
            });

            await tx.user.update({
                where: { id: userId },
                data: {
                    workStatus: activeAcceptedCount > 0 ? PlayerWorkStatus.WORKING : PlayerWorkStatus.IDLE,
                },
            });
        }
    }

    /**
     * 金额统一保留两位，避免优惠字段出现浮点误差。
     */
    private toAmount2(value: number) {
        return Number(Number(value || 0).toFixed(2));
    }

    private toAmountFen(value: number) {
        return Math.max(0, Math.round(Number(value || 0) * 100));
    }

    // 按 0.1 元精度均摊金额（对齐钱包余额精度），保证分摊和等于总额
    private splitSharedAmountByUsers(totalAmount: number, userIds: number[]) {
        const uniqueUserIds = Array.from(new Set((userIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)));
        if (!uniqueUserIds.length) return [] as Array<{ userId: number; amount: number }>;

        const totalTenths = Math.max(0, Math.round(Number(totalAmount || 0) * 10));
        const base = Math.floor(totalTenths / uniqueUserIds.length);
        let remainder = totalTenths - base * uniqueUserIds.length;

        return uniqueUserIds.map((userId) => {
            const extra = remainder > 0 ? 1 : 0;
            remainder = Math.max(0, remainder - extra);
            return {
                userId,
                amount: (base + extra) / 10,
            };
        });
    }

    private splitAmountByUsers2(totalAmount: number, userIds: number[]) {
        const uniqueUserIds = this.normalizeIdArray(userIds);
        if (!uniqueUserIds.length) return [] as Array<{ userId: number; amount: number }>;

        const totalCents = Math.max(0, Math.round(Number(totalAmount || 0) * 100));
        const base = Math.floor(totalCents / uniqueUserIds.length);
        let remainder = totalCents - base * uniqueUserIds.length;

        return uniqueUserIds.map((userId) => {
            const extra = remainder > 0 ? 1 : 0;
            remainder = Math.max(0, remainder - extra);
            return {
                userId,
                amount: (base + extra) / 100,
            };
        });
    }

    /**
     * 按权重分配金额，结果统一保留到 0.1 元，且总和等于总额。
     */
    private splitAmountByWeights(totalAmount: number, weights: number[]) {
        const totalTenths = Math.max(0, Math.round(Number(totalAmount || 0) * 10));
        const safeWeights = Array.isArray(weights)
            ? weights.map((n) => Math.max(0, Number(n || 0)))
            : [];
        const weightSum = safeWeights.reduce((sum, n) => sum + n, 0);

        if (!safeWeights.length) {
            return [];
        }

        if (weightSum <= 0) {
            const base = Math.floor(totalTenths / safeWeights.length);
            let remainder = totalTenths - base * safeWeights.length;
            return safeWeights.map(() => {
                const extra = remainder > 0 ? 1 : 0;
                remainder = Math.max(0, remainder - extra);
                return (base + extra) / 10;
            });
        }

        const raw = safeWeights.map((w) => (totalTenths * w) / weightSum);
        const units = raw.map((v) => Math.floor(v));
        let remainder = totalTenths - units.reduce((sum, n) => sum + n, 0);
        const order = raw
            .map((v, idx) => ({ idx, frac: v - units[idx] }))
            .sort((a, b) => b.frac - a.frac);

        for (let i = 0; i < order.length && remainder > 0; i += 1) {
            units[order[i].idx] += 1;
            remainder -= 1;
        }

        return units.map((n) => n / 10);
    }

    private normalizePlayerEvaluationLabel(score: any) {
        const n = Number(score);
        if (!Number.isFinite(n) || n < 1 || n > 5) {
            throw new BadRequestException('打手评分必须为 1-5 分');
        }

        const roundScore = Math.round(n);
        if (roundScore >= 4) {
            return { score: roundScore, ratingLabel: 'GOOD' as const };
        }
        if (roundScore === 3) {
            return { score: roundScore, ratingLabel: 'MEDIUM' as const };
        }
        return { score: roundScore, ratingLabel: 'BAD' as const };
    }

    private normalizeAfterSaleAction(action: any) {
        const v = String(action || '').trim().toUpperCase();
        if (!v) return null;
        const allow = new Set([
            'RESPONSIBLE_50',
            'RESPONSIBLE_100',
            'MAINTENANCE_FEE',
            'MAINTENANCE_REFUND',
            'NO_ACTION',
        ]);
        if (!allow.has(v)) {
            throw new BadRequestException('售后处理方式不合法');
        }
        return v;
    }

    private normalizeIdArray(input: any) {
        return Array.isArray(input)
            ? Array.from(
                new Set(
                    input
                        .map((x) => Number(x))
                        .filter((n) => Number.isFinite(n) && n > 0),
                ),
            )
            : [];
    }

    private resolveRenewalConfirmMode(dto: any): RenewalConfirmMode {
        const action = String(dto?.renewalAction || '').trim().toUpperCase();
        if (action === 'INVALIDATE') return 'INVALIDATE';
        if (action === 'SETTLE') return 'SETTLE';
        return Boolean(dto?.invalidateRenewal) ? 'INVALIDATE' : 'SETTLE';
    }

    private getRenewalInvalidateReason(input: any, message = '续单置为无效需填写原因') {
        return this.normalizeRequiredRemark(input, message).slice(0, 255);
    }

    private resolveRenewalBonusBaseAmount(order: any, baseAmountField?: string) {
        const field = String(baseAmountField || 'paidAmount').trim();
        const raw =
            field === 'settlementBaseAmount'
                ? order?.settlementBaseAmount
                : field === 'finalPayableAmount'
                    ? order?.finalPayableAmount
                    : order?.paidAmount;
        return this.toAmount2(Number(raw ?? 0));
    }

    private async resolveRenewalBonusRule(order: any) {
        const fallbackBaseAmount = this.resolveRenewalBonusBaseAmount(order, 'paidAmount');
        const fallbackRate = fallbackBaseAmount <= 300 ? 0.01 : 0.02;
        const fallback = {
            baseAmountField: 'paidAmount',
            baseAmount: fallbackBaseAmount,
            rate: fallbackRate,
            source: 'FALLBACK',
        };

        const config = await this.systemConfigService.getJson<any>(
            SystemConfigService.KEYS.ORDER_RENEWAL_BONUS_RULES,
            null as any,
        );
        if (!config || config.enabled === false) return fallback;

        const baseAmount = this.resolveRenewalBonusBaseAmount(order, config.baseAmountField);
        if (!Number.isFinite(baseAmount) || baseAmount <= 0) return fallback;

        const tiers = Array.isArray(config.tiers) ? config.tiers : [];
        for (const tier of tiers) {
            const min = tier?.min == null ? 0 : Number(tier.min);
            const max = tier?.max == null ? null : Number(tier.max);
            const rate = Number(tier?.rate);
            if (!Number.isFinite(min) || (max !== null && !Number.isFinite(max)) || !Number.isFinite(rate) || rate < 0) {
                continue;
            }
            if (baseAmount >= min && (max === null || baseAmount <= max)) {
                return {
                    baseAmountField: String(config.baseAmountField || 'paidAmount'),
                    baseAmount,
                    rate,
                    source: 'CONFIG',
                    tier,
                };
            }
        }

        return fallback;
    }

    private normalizeSettlementFreezeDays(value: any, fallback: number) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return fallback;
        return Math.floor(n);
    }

    private getExperienceFreezeDaysFromRule(rule: any) {
        return this.normalizeSettlementFreezeDays(rule?.settlementFreezeExperienceDays, 3);
    }

    private getRegularFreezeDaysFromRule(rule: any) {
        return this.normalizeSettlementFreezeDays(rule?.settlementFreezeRegularDays, 7);
    }

    private async buildSettlementFreezeInfoByUserTx(tx: any, order: any, userIds: number[]) {
        const uniqueUserIds = Array.from(new Set(userIds.map((id) => Number(id || 0)).filter((id) => id > 0)));
        const config = await this.staffRuleEngineService.getConfig();
        const users = uniqueUserIds.length
            ? await tx.user.findMany({
                where: { id: { in: uniqueUserIds } },
                select: { id: true, staffTags: true },
            })
            : [];
        const userById = new Map<number, any>(users.map((user: any) => [Number(user.id), user]));
        const defaultRule = this.staffRuleEngineService.resolveMatchedRule(config, []);
        const map = new Map<number, ReturnType<typeof computeSettlementFreezeTime>>();

        uniqueUserIds.forEach((userId) => {
            const user = userById.get(userId);
            const rule = this.staffRuleEngineService.resolveMatchedRule(config, user?.staffTags || []) || defaultRule;
            map.set(userId, computeSettlementFreezeTime({
                order,
                freezeDaysConfig: {
                    experienceDays: this.getExperienceFreezeDaysFromRule(rule),
                    regularDays: this.getRegularFreezeDaysFromRule(rule),
                },
            }));
        });

        return map;
    }

    private buildPlayerEvaluationKey(dispatchId: number, playerUserId: number) {
        return `${Number(dispatchId)}_${Number(playerUserId)}`;
    }

    private resolveInitialDispatcher(order: {
        initialDispatcherId?: number | null;
        dispatcherId?: number | null;
        initialDispatcher?: { id?: number | null; name?: string | null; userType?: string | null } | null;
        dispatcher?: { id?: number | null; name?: string | null; userType?: string | null } | null;
    }) {
        const initialDispatcherId = Number(order?.initialDispatcherId ?? 0) || null;
        if (initialDispatcherId) {
            return {
                userId: initialDispatcherId,
                user: order?.initialDispatcher || null,
            };
        }

        const dispatcherId = Number(order?.dispatcherId ?? 0) || null;
        return {
            userId: dispatcherId,
            user: order?.dispatcher || null,
        };
    }

    private async createRenewalGroupTx(params: {
        tx: any;
        orderId: number;
        dispatchId: number;
        playerIds: number[];
        renewalPlayerIds: number[];
        operatorId: number;
    }) {
        const { tx, orderId, dispatchId, playerIds, renewalPlayerIds, operatorId } = params;
        const normalizedPlayers = this.normalizeIdArray(playerIds);
        const normalizedRenewalPlayers = this.normalizeIdArray(renewalPlayerIds).sort((a, b) => a - b);
        if (!normalizedRenewalPlayers.length) {
            throw new BadRequestException('续单必须选择续单打手');
        }
        const playerSet = new Set(normalizedPlayers);
        const invalid = normalizedRenewalPlayers.filter((id) => !playerSet.has(id));
        if (invalid.length) {
            throw new BadRequestException('续单打手必须从当前派单打手中选择');
        }

        const users = await tx.user.findMany({
            where: { id: { in: normalizedRenewalPlayers } },
            select: { id: true, name: true, phone: true },
        });
        if (users.length !== normalizedRenewalPlayers.length) {
            throw new BadRequestException('续单打手不存在或已不可用');
        }
        const userMap = new Map<number, any>(users.map((u: any) => [Number(u.id), u]));
        const memberNamesSnapshot = normalizedRenewalPlayers.map((id) => {
            const u = userMap.get(id);
            return {
                id,
                name: u?.name || `#${id}`,
                phone: u?.phone || null,
            };
        });

        const group = await tx.orderRenewalGroup.create({
            data: {
                orderId,
                dispatchId,
                groupKey: normalizedRenewalPlayers.join(','),
                memberUserIds: normalizedRenewalPlayers as any,
                memberNamesSnapshot: memberNamesSnapshot as any,
                status: 'PENDING',
                createdBy: operatorId || null,
            },
        });

        await tx.order.update({
            where: { id: orderId },
            data: {
                isRenewal: true,
                inviter: null,
                inviteRate: 0,
            },
        });

        return group;
    }

    private async processRenewalAtConfirmTx(params: {
        tx: any;
        order: any;
        settlementBatchId: string;
        operatorId: number;
        mode: RenewalConfirmMode;
        invalidateReason?: string;
    }) {
        const { tx, order, settlementBatchId, operatorId, mode } = params;
        const orderId = Number(order?.id);
        const group = await tx.orderRenewalGroup.findUnique({
            where: { orderId },
            include: { bonuses: true },
        });
        if (!group) return { skipped: 'NO_RENEWAL_GROUP' };

        if (String(group.status) === 'SETTLED') return { skipped: 'ALREADY_SETTLED', groupId: group.id };
        if (['INVALIDATED', 'REVERSED'].includes(String(group.status))) {
            return { skipped: 'ALREADY_INACTIVE', groupId: group.id, status: group.status };
        }
        if (String(group.status) !== 'PENDING') {
            throw new BadRequestException(`续单状态异常，无法确认结算：${group.status}`);
        }

        if (mode === 'INVALIDATE') {
            const reason = this.getRenewalInvalidateReason(params.invalidateReason);
            await tx.orderRenewalGroup.update({
                where: { id: group.id },
                data: {
                    status: 'INVALIDATED',
                    invalidatedBy: operatorId,
                    invalidatedAt: new Date(),
                    invalidateReason: reason,
                },
            });
            await tx.order.update({
                where: { id: orderId },
                data: {
                    renewalAmount: 0,
                    renewalCount: 0,
                },
            });
            return { action: 'INVALIDATED', groupId: group.id, reason };
        }

        const memberUserIds = this.normalizeIdArray(group.memberUserIds);
        if (!memberUserIds.length) {
            throw new BadRequestException('续单组缺少续单打手，无法结算');
        }

        const rule = await this.resolveRenewalBonusRule(order);
        const bonusBaseAmount = this.toAmount2(Number(rule.baseAmount || 0));
        const bonusRate = Number(rule.rate || 0);
        const bonusTotalAmount = this.toAmount2(bonusBaseAmount * bonusRate);
        const settledAt = new Date();

        if (bonusBaseAmount <= 0 || bonusRate <= 0 || bonusTotalAmount <= 0) {
            await tx.orderRenewalGroup.update({
                where: { id: group.id },
                data: {
                    status: 'SETTLED',
                    renewalOrderCount: 1,
                    renewalAmount: bonusBaseAmount,
                    bonusBaseAmount,
                    bonusRate,
                    bonusTotalAmount: 0,
                    settlementBatchId,
                    settledBy: operatorId,
                    settledAt,
                },
            });
            await tx.order.update({
                where: { id: orderId },
                data: {
                    renewalAmount: bonusBaseAmount,
                    renewalCount: 1,
                },
            });
            return { action: 'SETTLED_NO_BONUS', groupId: group.id, bonusBaseAmount, bonusRate };
        }

        await this.assertPersistedOrderSettlementPayoutWithinBaseTx({
            tx,
            order,
            context: '续单分红结算',
            extraPositivePayoutAmount: bonusTotalAmount,
            extraAllowanceAmount: bonusTotalAmount,
        });

        const shares = this.splitAmountByUsers2(bonusTotalAmount, memberUserIds);
        const bonusRows: any[] = [];
        for (const share of shares) {
            const bonus = await tx.orderRenewalBonus.create({
                data: {
                    orderId,
                    renewalGroupId: group.id,
                    userId: share.userId,
                    bonusBaseAmount,
                    bonusRate,
                    bonusTotalAmount,
                    bonusShareAmount: share.amount,
                    status: 'PAID',
                    settlementBatchId,
                },
            });
            const walletTx = await this.wallet.creditAvailableBalance({
                userId: share.userId,
                amount: share.amount,
                bizType: WalletBizType.ORDER_RENEWAL_BONUS,
                sourceType: 'ORDER_RENEWAL_BONUS',
                sourceId: bonus.id,
                orderId,
                dispatchId: Number(group.dispatchId || 0) || null,
                remark: `续单分红：订单 ${order?.autoSerial || `#${orderId}`}`,
            }, tx);
            await tx.orderRenewalBonus.update({
                where: { id: bonus.id },
                data: { walletTransactionId: Number(walletTx.id) || null },
            });
            bonusRows.push({
                id: bonus.id,
                userId: share.userId,
                amount: share.amount,
                walletTransactionId: Number(walletTx.id) || null,
            });
        }

        await tx.orderRenewalGroup.update({
            where: { id: group.id },
            data: {
                status: 'SETTLED',
                renewalOrderCount: 1,
                renewalAmount: bonusBaseAmount,
                bonusBaseAmount,
                bonusRate,
                bonusTotalAmount,
                settlementBatchId,
                settledBy: operatorId,
                settledAt,
            },
        });
        await tx.order.update({
            where: { id: orderId },
            data: {
                renewalAmount: bonusBaseAmount,
                renewalCount: 1,
            },
        });

        return {
            action: 'SETTLED',
            groupId: group.id,
            groupKey: group.groupKey,
            bonusBaseAmount,
            bonusRate,
            bonusTotalAmount,
            bonusRows,
            ruleSource: rule.source,
        };
    }

    private async reverseRenewalBonusesTx(params: {
        tx: any;
        orderId: number;
        operatorId: number;
        reason: string;
        groupStatusAfter?: 'INVALIDATED' | 'REVERSED';
    }) {
        const { tx, orderId, operatorId } = params;
        const reason = this.getRenewalInvalidateReason(params.reason, '续单分红冲正需填写原因');
        const group = await tx.orderRenewalGroup.findUnique({
            where: { orderId: Number(orderId) },
            include: { bonuses: true },
        });
        if (!group) return { skipped: 'NO_RENEWAL_GROUP' };

        const now = new Date();
        if (String(group.status) === 'PENDING') {
            await tx.orderRenewalGroup.update({
                where: { id: group.id },
                data: {
                    status: 'INVALIDATED',
                    invalidatedBy: operatorId,
                    invalidatedAt: now,
                    invalidateReason: reason,
                },
            });
            await tx.order.update({
                where: { id: Number(orderId) },
                data: { renewalAmount: 0, renewalCount: 0 },
            });
            return { action: 'INVALIDATED_PENDING', groupId: group.id, reason };
        }

        if (!['SETTLED', 'REVERSED'].includes(String(group.status))) {
            return { skipped: 'ALREADY_INACTIVE', groupId: group.id, status: group.status };
        }

        const reversedRows: any[] = [];
        for (const bonus of group.bonuses || []) {
            if (String(bonus.status) === 'REVERSED') continue;
            const amount = this.toAmount2(Number(bonus.bonusShareAmount ?? 0));
            if (amount <= 0) {
                await tx.orderRenewalBonus.update({
                    where: { id: bonus.id },
                    data: {
                        status: 'REVERSED',
                        reversalReason: reason,
                        reversedAt: now,
                    },
                });
                continue;
            }

            const sourceId = Number(bonus.walletTransactionId || bonus.id);
            const existing = await tx.walletTransaction.findUnique({
                where: {
                    sourceType_sourceId: {
                        sourceType: 'ORDER_RENEWAL_BONUS_REVERSAL',
                        sourceId,
                    },
                },
                select: { id: true },
            });

            let reversalTxId = Number(existing?.id || 0);
            if (!existing) {
                await this.wallet.ensureWalletAccount(Number(bonus.userId), tx);
                const accountAfter = await tx.walletAccount.update({
                    where: { userId: Number(bonus.userId) },
                    data: {
                        availableBalance: { decrement: amount },
                    },
                    select: {
                        availableBalance: true,
                        frozenBalance: true,
                    },
                });
                const reversalTx = await tx.walletTransaction.create({
                    data: {
                        userId: Number(bonus.userId),
                        direction: WalletDirection.OUT,
                        bizType: WalletBizType.ORDER_RENEWAL_BONUS_REVERSAL,
                        amount,
                        status: WalletTxStatus.AVAILABLE,
                        sourceType: 'ORDER_RENEWAL_BONUS_REVERSAL',
                        sourceId,
                        orderId: Number(orderId),
                        dispatchId: Number(group.dispatchId || 0) || null,
                        reversalOfTxId: Number(bonus.walletTransactionId || 0) || null,
                        availableAfter: this.toAmount2(Number(accountAfter?.availableBalance ?? 0)),
                        frozenAfter: this.toAmount2(Number(accountAfter?.frozenBalance ?? 0)),
                        remark: reason,
                    },
                    select: { id: true },
                });
                reversalTxId = Number(reversalTx.id);
            }

            if (bonus.walletTransactionId) {
                await tx.walletTransaction.updateMany({
                    where: { id: Number(bonus.walletTransactionId), status: { not: WalletTxStatus.REVERSED } },
                    data: { status: WalletTxStatus.REVERSED },
                });
            }
            await tx.orderRenewalBonus.update({
                where: { id: bonus.id },
                data: {
                    status: 'REVERSED',
                    reversalWalletTransactionId: reversalTxId || null,
                    reversalReason: reason,
                    reversedAt: now,
                },
            });
            reversedRows.push({
                bonusId: bonus.id,
                userId: bonus.userId,
                amount,
                reversalWalletTransactionId: reversalTxId || null,
            });
        }

        await tx.orderRenewalGroup.update({
            where: { id: group.id },
            data: {
                status: params.groupStatusAfter || 'REVERSED',
                invalidatedBy: operatorId,
                invalidatedAt: now,
                invalidateReason: reason,
            },
        });
        await tx.order.update({
            where: { id: Number(orderId) },
            data: { renewalAmount: 0, renewalCount: 0 },
        });

        return {
            action: 'REVERSED',
            groupId: group.id,
            reason,
            reversedCount: reversedRows.length,
            reversedRows,
        };
    }

    private async applyPlayerEvaluationAdjustmentsToSettlements(params: {
        order: any;
        settlementsToCreate: any[];
        playerEvaluations?: any[];
        autoConfirm?: boolean;
        orderTipEnabled?: boolean;
        orderTipUserIds?: any[];
        skipValidation?: boolean;
    }) {
        const { order, settlementsToCreate } = params;
        const playerEvaluations = Array.isArray(params.playerEvaluations) ? params.playerEvaluations : [];
        const autoConfirm = Boolean(params.autoConfirm);
        const skipValidation = Boolean(params.skipValidation);
        const hasOrderTipPayload = params.orderTipEnabled !== undefined || Array.isArray(params.orderTipUserIds);
        const orderTipEnabled = hasOrderTipPayload ? Boolean(params.orderTipEnabled) : false;
        const requestedTipUserIds = this.normalizeIdArray(params.orderTipUserIds);
        const orderPaidAmount = this.getSettlementBaseAmountFromOrder(order);
        const tipPoolTotal = roundMix1(orderPaidAmount * 0.03);
        const csPoolTotal = roundMix1(orderPaidAmount * 0.01);
        const orderCutRaw = Number.isFinite(Number(order?.customClubRate))
            ? order.customClubRate
            : null;
        const projectCutRaw = Number.isFinite(Number(order?.projectSnapshot?.clubRate))
            ? order.projectSnapshot.clubRate
            : (Number.isFinite(Number(order?.project?.clubRate)) ? order.project?.clubRate : null);
        const hasFixedClubRate = orderCutRaw !== null || projectCutRaw !== null;

        const playerRows = settlementsToCreate.filter((s: any) => String(s?.settlementType || '') !== 'CUSTOMER_SERVICE');
        const regularPlayerRows = playerRows.filter((s: any) => String(s?.settlementType || '') !== 'CARRY_COMPENSATION');
        const carryCompRows = playerRows.filter((s: any) => String(s?.settlementType || '') === 'CARRY_COMPENSATION');
        const adjustablePlayerRows = regularPlayerRows;
        const csRows = settlementsToCreate.filter((s: any) => String(s?.settlementType || '') === 'CUSTOMER_SERVICE');

        if (!adjustablePlayerRows.length) {
            return { settlementsToCreate, evaluationRows: [] as any[] };
        }

        const evalMap = new Map<string, any>();
        if (autoConfirm) {
            for (const row of adjustablePlayerRows) {
                const key = this.buildPlayerEvaluationKey(Number(row.dispatchId), Number(row.userId));
                evalMap.set(key, {
                    dispatchId: Number(row.dispatchId),
                    playerUserId: Number(row.userId),
                    score: 3,
                    ratingLabel: 'MEDIUM',
                    responsibleUserIds: [],
                    tippedUserIds: [],
                    afterSaleHandled: false,
                    afterSaleAction: null,
                    tipPoolAmount: null,
                    tipAmount: 0,
                    penaltyAmount: 0,
                    maintenanceFeeAmount: 0,
                    reviewRemark: 'SYSTEM_AUTO_CONFIRM_72H',
                });
            }
        }
        for (const item of playerEvaluations) {
            const dispatchId = Number(item?.dispatchId);
            const playerUserId = Number(item?.playerUserId);
            if (!Number.isFinite(dispatchId) || dispatchId <= 0 || !Number.isFinite(playerUserId) || playerUserId <= 0) {
                continue;
            }
            const { score, ratingLabel } = this.normalizePlayerEvaluationLabel(item?.score);
            const responsibleUserIds = this.normalizeIdArray(item?.responsibleUserIds);
            const tippedUserIds = this.normalizeIdArray(item?.tippedUserIds);
            const afterSaleHandled = Boolean(item?.afterSaleHandled);
            const afterSaleAction = this.normalizeAfterSaleAction(item?.afterSaleAction);
            evalMap.set(this.buildPlayerEvaluationKey(dispatchId, playerUserId), {
                ...item,
                dispatchId,
                playerUserId,
                score,
                ratingLabel,
                responsibleUserIds,
                tippedUserIds,
                afterSaleHandled,
                afterSaleAction,
            });
        }

        const missingKeys: string[] = [];
        if (!autoConfirm) {
            for (const row of adjustablePlayerRows) {
                const key = this.buildPlayerEvaluationKey(Number(row.dispatchId), Number(row.userId));
                if (!evalMap.has(key)) missingKeys.push(key);
            }
        }
        if (missingKeys.length) {
            throw new BadRequestException(`请先完成全部打手评价：${Array.from(new Set(missingKeys)).join(',')}`);
        }

        const rowStates = adjustablePlayerRows.map((row: any) => {
            const key = this.buildPlayerEvaluationKey(Number(row.dispatchId), Number(row.userId));
            const evalItem = evalMap.get(key);
            const baseAmount = roundMix1(Number(row.contributionBaseAmount ?? 0));
            const currentFinal = roundMix1(Number(row.finalEarnings ?? 0));
            const base65 = roundMix1(baseAmount * 0.65);
            // 炸单轮：保持订单基础比例算出来的原始负数，不允许被评级/段位改写。
            const isBombLoss = currentFinal < 0;
            const baseFinalBeforeExtras = isBombLoss
                ? currentFinal
                : (evalItem.ratingLabel === 'GOOD' ? currentFinal : base65);
            return {
                key,
                row,
                evalItem,
                baseAmount,
                currentFinal,
                base65,
                baseFinalBeforeExtras,
                isBombLoss,
                userId: Number(row.userId),
                dispatchId: Number(row.dispatchId),
            };
        });

        const userStates = new Map<number, any[]>();
        const goodParticipantIds = new Set<number>();
        const badParticipantIds = new Set<number>();
        for (const st of rowStates) {
            if (st.evalItem.ratingLabel === 'GOOD') goodParticipantIds.add(Number(st.userId));
            if (st.evalItem.ratingLabel === 'BAD') badParticipantIds.add(Number(st.userId));
            const list = userStates.get(st.userId) || [];
            list.push(st);
            userStates.set(st.userId, list);
        }

        // 1) 对“责任打手”生成处罚池（按用户聚合，再分到该用户各自结算行）
        const penaltyByUser = new Map<number, number>();
        const maintenanceByUser = new Map<number, number>();

        for (const st of rowStates) {
            const evalItem = st.evalItem;
            if (evalItem.ratingLabel !== 'BAD' || !evalItem.afterSaleHandled || !evalItem.afterSaleAction) continue;
            const responsibleUserIds = evalItem.responsibleUserIds || [];
            if (!responsibleUserIds.length) continue;

            const maintenanceFee = Math.max(roundMix1(orderPaidAmount * 0.2), 20);
            for (const responsibleUserId of responsibleUserIds) {
                const targetRows = userStates.get(Number(responsibleUserId)) || [];
                if (!targetRows.length) continue;

                const targetEntitledTotal = targetRows.reduce((sum, r) => sum + Number(r.baseFinalBeforeExtras ?? 0), 0);
                if (targetEntitledTotal <= 0) continue;

                let penaltyTotal = 0;
                if (evalItem.afterSaleAction === 'RESPONSIBLE_50') {
                    penaltyTotal = roundMix1(targetEntitledTotal * 0.5);
                } else if (evalItem.afterSaleAction === 'RESPONSIBLE_100') {
                    penaltyTotal = roundMix1(targetEntitledTotal);
                } else if (evalItem.afterSaleAction === 'MAINTENANCE_FEE' || evalItem.afterSaleAction === 'MAINTENANCE_REFUND') {
                    penaltyTotal = maintenanceFee;
                } else {
                    penaltyTotal = 0;
                }

                if (penaltyTotal > 0) {
                    if (evalItem.afterSaleAction === 'MAINTENANCE_FEE' || evalItem.afterSaleAction === 'MAINTENANCE_REFUND') {
                        maintenanceByUser.set(Number(responsibleUserId), roundMix1((maintenanceByUser.get(Number(responsibleUserId)) || 0) + penaltyTotal));
                    } else {
                        penaltyByUser.set(Number(responsibleUserId), roundMix1((penaltyByUser.get(Number(responsibleUserId)) || 0) + penaltyTotal));
                    }
                }
            }
        }

        // 2) 打赏池：全单只取一次 3%，订单级下拉选择；候选只来自非差评参与者
        const allowedTipUserIds = Array.from(goodParticipantIds).filter((userId) => !badParticipantIds.has(Number(userId)));
        const requestedTipUserIdsFiltered = requestedTipUserIds.filter((userId) => allowedTipUserIds.includes(Number(userId)));
        if (hasOrderTipPayload) {
            if (orderTipEnabled) {
                if (!requestedTipUserIds.length) {
                    throw new BadRequestException(`已开启打赏但未选择被打赏打手，无法结单：orderId=${order.id}`);
                }
                const invalidTipUserIds = requestedTipUserIds.filter((userId) => !allowedTipUserIds.includes(Number(userId)));
                if (invalidTipUserIds.length) {
                    throw new BadRequestException(`打赏打手选择无效，存在不允许打赏的打手：${Array.from(new Set(invalidTipUserIds)).join(',')}`);
                }
            } else if (requestedTipUserIds.length > 0) {
                throw new BadRequestException(`打赏开关已关闭，但仍提交了打赏打手，无法结单：orderId=${order.id}`);
            }
        }
        const legacyTipUserIds = Array.from(new Set(
            rowStates
                .filter((st) => st.evalItem.ratingLabel === 'GOOD')
                .flatMap((st) => st.evalItem.tippedUserIds || [])
                .map((x) => Number(x))
                .filter((n) => Number.isFinite(n) && n > 0 && allowedTipUserIds.includes(Number(n))),
        ));
        const tippedUserIds = hasOrderTipPayload
            ? (orderTipEnabled ? requestedTipUserIdsFiltered : [])
            : legacyTipUserIds;

        const tipByUser = new Map<number, number>();
        if (tippedUserIds.length > 0 && tipPoolTotal > 0) {
            const shares = this.splitAmountByWeights(tipPoolTotal, tippedUserIds.map(() => 1));
            tippedUserIds.forEach((userId, idx) => {
                const share = Number(shares[idx] ?? 0);
                if (share > 0) tipByUser.set(Number(userId), share);
            });
        }

        // 3) 按用户层面分配 tip / penalty 到每条结算行
        const rowAdjustments = new Map<string, {
            tipAmount: number;
            penaltyAmount: number;
            maintenanceFeeAmount: number;
        }>();

        for (const [userId, rows] of userStates.entries()) {
            const penaltyTotal = roundMix1(Number(penaltyByUser.get(userId) || 0));
            const maintenanceTotal = roundMix1(Number(maintenanceByUser.get(userId) || 0));
            const tipTotal = roundMix1(Number(tipByUser.get(userId) || 0));
            const weightsForPenalty = rows.map((r) => Number(r.baseFinalBeforeExtras ?? 0));
            const weightsForTip = rows.map((r) => Number(r.baseFinalBeforeExtras ?? 0));

            const penaltyShares = penaltyTotal > 0 ? this.splitAmountByWeights(penaltyTotal, weightsForPenalty) : rows.map(() => 0);
            const maintenanceShares = maintenanceTotal > 0 ? this.splitAmountByWeights(maintenanceTotal, weightsForPenalty) : rows.map(() => 0);
            const tipShares = tipTotal > 0 ? this.splitAmountByWeights(tipTotal, weightsForTip) : rows.map(() => 0);

            rows.forEach((r, idx) => {
                const penaltyAmount = roundMix1(Number(penaltyShares[idx] ?? 0));
                const maintenanceFeeAmount = roundMix1(Number(maintenanceShares[idx] ?? 0));
                const tipAmount = roundMix1(Number(tipShares[idx] ?? 0));
                rowAdjustments.set(r.key, {
                    tipAmount,
                    penaltyAmount,
                    maintenanceFeeAmount,
                });
            });
        }

        // 4) CS 1% 独立生成，不再从玩家收益池里扣
        const allWeights = rowStates.map((r) => {
            const adj = rowAdjustments.get(r.key);
            const preCs = roundMix1(
                (Number(r.baseFinalBeforeExtras ?? 0)
                    - Number(adj?.penaltyAmount ?? 0)
                    - Number(adj?.maintenanceFeeAmount ?? 0))
                + Number(adj?.tipAmount ?? 0),
            );
            return Math.max(0, preCs);
        });
        const csShares = csPoolTotal > 0 ? this.splitAmountByWeights(csPoolTotal, allWeights) : rowStates.map(() => 0);

        const playerRowsByKey = new Map(adjustablePlayerRows.map((r: any) => [this.buildPlayerEvaluationKey(Number(r.dispatchId), Number(r.userId)), r]));
        const evaluationRows: any[] = [];

        rowStates.forEach((st, idx) => {
            const row = playerRowsByKey.get(st.key);
            if (!row) return;

            // 炸单轮直接沿用原始负数结算，不参与评级/段位/打赏/责任扣款改写。
            if (st.isBombLoss) {
                row.calculatedEarnings = roundMix1(st.currentFinal);
                row.manualAdjustment = 0;
                row.finalEarnings = roundMix1(st.currentFinal);
                row.clubEarnings = 0;
                row.csEarnings = 0;
                row.inviteEarnings = 0;

                evaluationRows.push({
                    key: st.key,
                    dispatchId: st.dispatchId,
                    playerUserId: st.userId,
                    score: st.evalItem.score,
                    ratingLabel: st.evalItem.ratingLabel,
                    afterSaleHandled: Boolean(st.evalItem.afterSaleHandled),
                    afterSaleAction: st.evalItem.afterSaleAction,
                    responsibleUserIds: st.evalItem.responsibleUserIds || [],
                    tippedUserIds: [],
                    tipPoolAmount: null,
                    tipAmount: 0,
                    penaltyAmount: 0,
                    maintenanceFeeAmount: 0,
                    reviewRemark: st.evalItem.reviewRemark || null,
                    playerName: row.userName,
                });
                return;
            }

            const adjust = rowAdjustments.get(st.key) || { tipAmount: 0, penaltyAmount: 0, maintenanceFeeAmount: 0 };
            const csAmount = roundMix1(Number(csShares[idx] ?? 0));
            const preCsFinal = roundMix1(
                (Number(st.baseFinalBeforeExtras ?? 0)
                    - Number(adjust.penaltyAmount ?? 0)
                    - Number(adjust.maintenanceFeeAmount ?? 0))
                + Number(adjust.tipAmount ?? 0),
            );
            // 炸单轮必须保留负数结算值，不能在这里钳成 0。
            // 负数意味着该轮需要作为补单/炸单损耗进入后续结算与钱包冲正链路。
            const playerGrossBeforeCs = roundMix1(preCsFinal);
            const finalEarnings = hasFixedClubRate
                ? roundMix1(playerGrossBeforeCs - csAmount)
                : roundMix1(playerGrossBeforeCs);
            const clubEarnings = roundMix1(
                Math.max(
                    0,
                    Number(st.baseAmount ?? 0)
                    - Number(finalEarnings ?? 0)
                    - Number(csAmount ?? 0),
                ),
            );

            row.calculatedEarnings = finalEarnings;
            row.manualAdjustment = 0;
            row.finalEarnings = finalEarnings;
            row.clubEarnings = clubEarnings;
            row.csEarnings = csAmount;
            row.inviteEarnings = roundMix1(Number(adjust.tipAmount ?? 0));

            if (Number(row.clubEarnings ?? 0) < -0.1) {
                throw new BadRequestException(`俱乐部收益异常，无法结单：orderId=${order.id}, dispatchId=${st.dispatchId}, userId=${st.userId}`);
            }

            evaluationRows.push({
                key: st.key,
                dispatchId: st.dispatchId,
                playerUserId: st.userId,
                score: st.evalItem.score,
                ratingLabel: st.evalItem.ratingLabel,
                afterSaleHandled: Boolean(st.evalItem.afterSaleHandled),
                afterSaleAction: st.evalItem.afterSaleAction,
                responsibleUserIds: st.evalItem.responsibleUserIds || [],
                tippedUserIds: st.evalItem.ratingLabel === 'GOOD' ? tippedUserIds : [],
                tipPoolAmount: tipPoolTotal > 0 ? tipPoolTotal : null,
                tipAmount: roundMix1(Number(adjust.tipAmount ?? 0)),
                penaltyAmount: roundMix1(Number(adjust.penaltyAmount ?? 0)),
                maintenanceFeeAmount: roundMix1(Number(adjust.maintenanceFeeAmount ?? 0)),
                reviewRemark: st.evalItem.reviewRemark || null,
                playerName: row.userName,
            });
        });

        // 5) CS settlement 行保持其自身收益，不参与评级扣款
        const playerBaseTotal = roundMix1(
            regularPlayerRows.reduce((sum, st: any) => sum + Number(st.contributionBaseAmount ?? 0), 0),
        );
        // 结算总额只看实际要入钱包/发放的 finalEarnings，clubEarnings 只是内部拆账，不参与总额校验。
        const playerTotalBeforeCs = roundMix1(
            regularPlayerRows.reduce((sum, st: any) => sum + Number(st.finalEarnings ?? 0), 0)
            + carryCompRows.reduce((sum, st: any) => sum + Number(st.finalEarnings ?? 0), 0),
        );
        // 炸单补单额度：
        // - 直接按“评级调整前的原始结算值”中出现的负数轮次绝对值求和
        // - 不能用 regularPlayerRows.finalEarnings，因为上面的评级/客服分红逻辑可能已经把负数清零
        // - 这里必须使用 rowStates.currentFinal，它保留了原始结算值
        const bombLossAllowance = roundMix1(
            rowStates.reduce((sum, st: any) => {
                const v = Number(st.currentFinal ?? 0);
                return v < 0 ? sum + (-v) : sum;
            }, 0),
        );
        const csRowTotal = roundMix1(
            csRows.reduce((sum, r: any) => sum + Number(r.finalEarnings ?? r.calculatedEarnings ?? 0), 0),
        );

        // 实际已支出总额：
        // - 普通打手的实际发放金额
        // - 加上客服 1% 分红
        // 注意：这里不把 clubEarnings 算进去，clubEarnings 只是内部拆账，不是实际支出。
        const settledTotal = round2(playerTotalBeforeCs + csRowTotal);

        // 订单原始实付金额：
        // - 主要用于财务对账、现金核对
        // - 不是当前结单总额校验的直接基准
        const paidTotal = round2(orderPaidAmount);

        // 订单结算基数：
        // - 结单时的基础结算金额
        // - 老数据为空/0 时会回退到实付金额
        // - 这是本单允许支出的基础上限
        const settlementBasisTotal = round2(this.getSettlementBaseAmountFromOrder(order));

        // 允许支出上限：
        // = 订单结算金额
        // + 炸单补单额度（负数轮次的绝对值）
        // + 客服分红
        // 只要实际支出不超过这个值，就允许结单。
        const totalSettlementAllowance = round2(settlementBasisTotal + bombLossAllowance + csRowTotal);

        // 允许额度下的剩余空间：
        // = 允许支出上限 - 实际已支出总额
        // 为正表示还没用满额度
        // 为 0 表示刚好用满
        // 为负表示已经超支
        const totalShortfall = round2(totalSettlementAllowance - settledTotal);

        // 打手基础总额：
        // - 只统计普通打手行的 contributionBaseAmount
        // - 这是“基础分摊金额”的汇总
        const baseTotal = round2(playerBaseTotal);

        // 基础短缺：
        // = 结算基数 - 当前已分到的基础金额
        // 这个值主要用于调试/对账，不直接作为结单失败条件
        const baseShortfall = round2(settlementBasisTotal - baseTotal);

        // 基础金额是否超出结算基数：
        // - true 表示基础分摊已经超过订单结算基数
        // - 这里只做诊断输出，不再作为硬拦截
        const baseMismatch = baseTotal - settlementBasisTotal > 0.1;

        // 总支出是否超出允许上限：
        // - true 表示实际支出已经超过：结算基数 + 炸单补单 + 客服分红
        // - 这是当前真正的硬拦截条件
        const totalMismatch = settledTotal - totalSettlementAllowance > 0.1;

        // 是否在允许范围内：
        // - 只是一个结果标记，方便预览/调试
        // - 不直接参与 throw
        const totalWithinTolerance = settledTotal <= totalSettlementAllowance + 0.1;

        if (totalMismatch && !skipValidation) {
            throw new BadRequestException(`订单支出总额超出结算金额，无法结单：orderId=${order.id}`);
        }

        for (const csRow of csRows) {
            csRow.calculatedEarnings = roundMix1(Number(csRow.calculatedEarnings ?? csRow.finalEarnings ?? 0));
            csRow.manualAdjustment = roundMix1(Number(csRow.manualAdjustment ?? 0));
            csRow.finalEarnings = roundMix1(Number(csRow.finalEarnings ?? csRow.calculatedEarnings ?? 0));
            csRow.clubEarnings = roundMix1(Number(csRow.clubEarnings ?? 0));
            csRow.csEarnings = roundMix1(Number(csRow.csEarnings ?? 0));
            csRow.inviteEarnings = roundMix1(Number(csRow.inviteEarnings ?? 0));
        }

        return {
            settlementsToCreate,
            evaluationRows,
            tipPoolTotal,
            csPoolTotal,
            validation: {
                orderPaidAmount,
                playerBaseTotal,
                bombLossAllowance,
                baseTotal,
                baseShortfall,
                playerTotalBeforeCs,
                csRowTotal,
                settledTotal,
                totalSettlementAllowance,
                paidTotal,
                settlementBasisTotal,
                totalShortfall,
                baseMismatch,
                totalMismatch,
                totalWithinTolerance,
            },
        };
    }

    /**
     * 根据已拆分优惠字段，计算订单优惠类型标签。
     * 用途：列表/统计快速分组，不替代明细表。
     */
    private resolveDiscountType(input: {
        couponDiscountAmount: number;
        activityDiscountAmount: number;
        giftDiscountAmount: number;
        manualAdjustAmount: number;
    }): string {
        const types: string[] = [];
        if (input.couponDiscountAmount > 0) types.push('COUPON');
        if (input.activityDiscountAmount > 0) types.push('ACTIVITY');
        if (input.giftDiscountAmount > 0) types.push('GIFT');
        if (input.manualAdjustAmount > 0) types.push('MANUAL');
        if (!types.length) return 'NONE';
        if (types.length === 1) return types[0];
        return 'MIXED';
    }

    private isAutoRefundSupportedChannel(channel?: string | null) {
        const c = String(channel || '').trim().toUpperCase();
        return c === 'MINIAPP_WECHAT' || c === 'WECHAT' || c === 'BALANCE';
    }

    private resolvePaymentChannelByOrderSource(orderSource?: string | null) {
        const source = String(orderSource || '').trim().toUpperCase() || 'CUSTOMER_SERVICE_MANUAL';
        if (source === 'MINIAPP_SELF_SERVICE') return 'MINIAPP_WECHAT';
        if (source === 'CUSTOMER_SERVICE_MANUAL') return 'MANUAL_SHOUQIANBA';
        if (source === 'TUTU_PLATFORM') return 'TUTU_PLATFORM';
        if (source === 'THIRD_PARTY_TRANSFER' || source === 'OFFICIAL_ACCOUNT') return 'THIRD_PARTY_CHANNEL';
        return 'MANUAL_SHOUQIANBA';
    }

    private buildOrderPaymentNo(channel: string, orderId: number) {
        const prefixMap: Record<string, string> = {
            MINIAPP_WECHAT: 'WXM',
            BALANCE: 'BAL',
            MANUAL_SHOUQIANBA: 'SQB',
            TUTU_PLATFORM: 'TUT',
            THIRD_PARTY_CHANNEL: 'THD',
        };
        const prefix = prefixMap[String(channel || '').trim().toUpperCase()] || 'PAY';
        return `${prefix}-${orderId}-${Date.now()}`;
    }

    private buildRefundNo(channel: string, orderId: number) {
        const prefixMap: Record<string, string> = {
            MINIAPP_WECHAT: 'RWX',
            WECHAT: 'RWX',
            BALANCE: 'RBL',
            MANUAL_SHOUQIANBA: 'RSQ',
            TUTU_PLATFORM: 'RTU',
            THIRD_PARTY_CHANNEL: 'RTP',
        };
        const prefix = prefixMap[String(channel || '').trim().toUpperCase()] || 'RFD';
        return `${prefix}-${orderId}-${Date.now()}`;
    }

    private async ensureLegacySuccessfulPaymentForRefund(order: any) {
        const latestPaymentStatus = String(order?.latestPayment?.status || '').trim().toUpperCase();
        if (latestPaymentStatus === OrderPayStatus.SUCCESS) {
            return order;
        }
        if (!this.isOrderEffectivelyPaidOrGifted(order as any)) {
            return order;
        }

        const paymentAmount = this.toAmount2(
            Number(
                order?.paidAmount ??
                order?.finalPayableAmount ??
                order?.receivableAmount ??
                0,
            ),
        );
        if (paymentAmount <= 0) {
            return order;
        }

        const paymentChannel = this.resolvePaymentChannelByOrderSource(order?.orderSource);
        const paidAt = order?.paymentTime
            ? new Date(order.paymentTime)
            : (order?.updatedAt ? new Date(order.updatedAt) : new Date());

        const payment = await this.prisma.orderPayment.create({
            data: {
                orderId: Number(order.id),
                paymentNo: this.buildOrderPaymentNo(String(paymentChannel), Number(order.id)),
                channel: paymentChannel,
                status: OrderPayStatus.SUCCESS,
                amount: paymentAmount,
                currency: 'CNY',
                paidAt,
            },
            select: {
                id: true,
                channel: true,
                status: true,
                amount: true,
                transactionId: true,
                paymentNo: true,
            },
        });

        await this.prisma.order.update({
            where: { id: Number(order.id) },
            data: {
                latestPaymentId: payment.id,
                paymentTime: order?.paymentTime ? new Date(order.paymentTime) : paidAt,
                isPaid: true,
                payStatus: OrderPayStatus.SUCCESS,
            },
        });

        return {
            ...order,
            latestPayment: payment,
            latestPaymentId: payment.id,
            paymentTime: order?.paymentTime ? new Date(order.paymentTime) : paidAt,
            isPaid: true,
            payStatus: OrderPayStatus.SUCCESS,
        };
    }

    private shouldAutoRefundWithWechat(order: {
        orderSource?: string | null;
        latestPayment?: {
            channel?: string | null;
            status?: string | null;
            transactionId?: string | null;
            paymentNo?: string | null;
            amount?: any;
        } | null;
    }) {
        const orderSource = String(order?.orderSource || '').trim().toUpperCase();
        if (orderSource !== 'MINIAPP_SELF_SERVICE') return false;
        const channel = String(order?.latestPayment?.channel || '').trim().toUpperCase();
        const status = String(order?.latestPayment?.status || '').trim().toUpperCase();
        return (channel === 'MINIAPP_WECHAT' || channel === 'WECHAT') && status === OrderPayStatus.SUCCESS;
    }

    private getDefaultOrderSourceByScene(scene?: OrderCreateScene) {
        if (scene === 'MINIAPP') return 'MINIAPP_SELF_SERVICE';
        if (scene === 'OFFICIAL_ACCOUNT') return 'OFFICIAL_ACCOUNT';
        return 'CUSTOMER_SERVICE_MANUAL';
    }

    private async getOrderSourceOptions() {
        const list = await this.systemConfigService.getOrderSourceOptions();
        return Array.isArray(list) && list.length ? list : ORDER_SOURCE_DEFAULTS;
    }

    private async normalizeOrderSource(input: unknown, scene?: OrderCreateScene) {
        const value = String(input || '').trim();
        const list = await this.getOrderSourceOptions();
        const hit = list.find((item) => item.value === value);
        if (value) {
            if (!hit) throw new BadRequestException('订单渠道来源无效');
            if (hit.enabled === false) throw new BadRequestException('订单渠道来源已停用');
            return hit.value;
        }
        return this.getDefaultOrderSourceByScene(scene);
    }

    private async resolveOrderSourceLabel(orderSource?: string | null) {
        const code = String(orderSource || '').trim() || 'CUSTOMER_SERVICE_MANUAL';
        const list = await this.getOrderSourceOptions();
        return list.find((item) => item.value === code)?.label || code;
    }

    private canDispatchBeforePaid(order: { isGifted?: boolean | null; orderSource?: string | null }) {
        const source = String(order?.orderSource || '').trim() || 'CUSTOMER_SERVICE_MANUAL';
        return Boolean(order?.isGifted) || source === 'CUSTOMER_SERVICE_MANUAL';
    }

    private async calcCouponDiscount(params: {
        originalAmount: number;
        projectId: number;
        template: {
            id: number;
            name: string;
            type: CouponTemplateType;
            status: CouponTemplateStatus;
            discountValue: any;
            thresholdAmount: any;
            maxDiscountAmount: any;
            applicableScope: CouponScope;
            applicableProjectIds: any;
            startAt: Date | null;
            endAt: Date | null;
        };
    }) {
        const { originalAmount, projectId, template } = params;
        const now = new Date();
        if (template.status !== CouponTemplateStatus.ACTIVE) {
            throw new BadRequestException('优惠券不可用（状态非生效）');
        }
        if (template.startAt && now < template.startAt) {
            throw new BadRequestException('优惠券尚未开始生效');
        }
        if (template.endAt && now > template.endAt) {
            throw new BadRequestException('优惠券已过期');
        }
        if (template.applicableScope === CouponScope.PROJECT) {
            const ids = Array.isArray(template.applicableProjectIds)
                ? template.applicableProjectIds.map((x: any) => Number(x)).filter((x: number) => Number.isFinite(x))
                : [];
            if (!ids.includes(Number(projectId))) {
                throw new BadRequestException('该优惠券不适用于当前商品');
            }
        }
        if (template.applicableScope === CouponScope.CATEGORY) {
            const project = await this.prisma.gameProject.findUnique({ where: { id: Number(projectId) }, select: { id: true, category: true } });
            const categoryId = String(project?.category || '').trim();
            const ids = Array.isArray(template.applicableProjectIds)
                ? template.applicableProjectIds.map((x: any) => String(x || '').trim()).filter((x: string) => !!x)
                : [];
            if (!categoryId || !ids.includes(categoryId)) {
                throw new BadRequestException('该优惠券不适用于当前商品分类');
            }
        }

        const discountValue = Number(template.discountValue ?? 0);
        const thresholdAmount = Number(template.thresholdAmount ?? 0);
        const maxDiscountAmount = Number(template.maxDiscountAmount ?? 0);
        let discount = 0;

        if (template.type === CouponTemplateType.CASH) {
            discount = discountValue;
        } else if (template.type === CouponTemplateType.FULL_REDUCTION) {
            if (originalAmount < thresholdAmount) {
                throw new BadRequestException(`未满足满减门槛：满${thresholdAmount}可用`);
            }
            discount = discountValue;
        } else if (template.type === CouponTemplateType.DISCOUNT) {
            let rate = discountValue;
            if (rate > 1) rate = rate / 10; // 兼容 8 表示 8 折
            if (!(rate > 0 && rate <= 1)) {
                throw new BadRequestException('折扣券配置异常');
            }
            discount = originalAmount * (1 - rate);
        } else if (template.type === CouponTemplateType.FREE) {
            discount = originalAmount;
        }

        discount = Math.max(0, discount);
        if (maxDiscountAmount > 0) {
            discount = Math.min(discount, maxDiscountAmount);
        }
        return this.toAmount2(Math.min(discount, originalAmount));
    }

    private readonly settlementRepairCache = new Map<
        number,
        {
            settlementsToCreate: any[];
            snapshot: {
                orderId: number;
                updatedAt: Date | null;
                paidAmount: number;
                settlementBaseAmount: number;
                status: any;
                dispatchCount: number;
                modePlayAllocList?: any[];
                playerEvaluations?: any[];
                orderTipEnabled?: boolean;
                orderTipUserIds?: number[];
            };
        }
    >();;

    /*** -----------------------------
     * 创建订单方法
     * -----------------------------*/
    async createOrder(dto: CreateOrderDto, operatorId: number, context?: CreateOrderContext) {
        const scene = context?.scene || 'ADMIN';
        const dispatcherId = context?.dispatcherId === undefined ? operatorId : context.dispatcherId;
        const customerUserId =
            context?.customerUserId != null
                ? Number(context.customerUserId)
                : ((dto as any)?.customerUserId != null ? Number((dto as any).customerUserId) : null);
        const orderSource = await this.normalizeOrderSource(dto?.orderSource, scene);
        const project = await this.prisma.gameProject.findUnique({where: {id: dto.projectId}});
        if (!project) throw new NotFoundException('项目不存在');

        const playerIds = Array.isArray((dto as any)?.playerIds)
            ? this.normalizeIdArray((dto as any).playerIds)
            : [];
        const isRenewal = Boolean((dto as any).isRenewal);
        const renewalPlayerIds = this.normalizeIdArray((dto as any).renewalPlayerIds);
        if (isRenewal) {
            if (!playerIds.length) {
                throw new BadRequestException('续单只能在创建订单首轮派单时设置，请先选择派单打手');
            }
            if (!renewalPlayerIds.length) {
                throw new BadRequestException('续单必须选择续单打手');
            }
            const playerSet = new Set(playerIds);
            if (renewalPlayerIds.some((id) => !playerSet.has(id))) {
                throw new BadRequestException('续单打手必须从当前派单打手中选择');
            }
        }
        if (playerIds.length) {
            const playerCount = await this.prisma.user.count({
                where: { id: { in: playerIds } },
            });
            if (playerCount !== playerIds.length) {
                throw new BadRequestException('派单打手不存在或已不可用');
            }
        }

        // 默认客服分佣：体验单为 0，其他为 0.01
        const defaultCsRate = project.type === 'EXPERIENCE' ? 0 : 0.01;

        // 默认推广分佣：有 inviter 才默认 0.05
        const defaultInviteRate = isRenewal ? 0 : (dto.inviter ? 0.05 : 0);

        // 默认俱乐部抽成：订单级优先，其次项目默认；允许为空（表示未来按评级等扩展）
        const clubRate = dto.customClubRate ?? project.clubRate ?? null;

        // 项目快照（防止项目改价/改抽成后影响历史订单）
        const projectSnapshot = {
            id: project.id,
            name: project.name,
            type: project.type,
            billingMode: project.billingMode,
            price: project.price,
            baseAmount: project.baseAmount ?? null,
            clubRate: project.clubRate ?? null,
            coverImage: project.coverImage ?? null,
        };

        const serial = await this.generateOrderSerial();
        const userCouponId = Number((dto as any).userCouponId || 0);
        let selectedUserCoupon: any = null;
        if (userCouponId > 0) {
            selectedUserCoupon = await this.prisma.userCoupon.findUnique({
                where: { id: userCouponId },
                include: { template: true },
            });
            if (!selectedUserCoupon) {
                throw new BadRequestException('用户券不存在');
            }
            if (!customerUserId || Number(selectedUserCoupon.userId) !== Number(customerUserId)) {
                throw new BadRequestException('该优惠券不属于当前下单用户');
            }
            if (selectedUserCoupon.status !== UserCouponStatus.UNUSED) {
                throw new BadRequestException('优惠券已使用或不可用');
            }
            if (selectedUserCoupon.expiresAt && new Date(selectedUserCoupon.expiresAt) < new Date()) {
                throw new BadRequestException('优惠券已过期');
            }
        }

        // ✅ 赠送单：不收款，但仍然要正常结算/分红
        // - 为避免前端误传金额导致“赠送单被计入营收”，后端这里强制清零
        const isGifted = Boolean(dto.isGifted);

        // 赠送金额口径（本期统一为“按应收承担成本”）
        const originalAmount = this.toAmount2(Number(dto.receivableAmount ?? 0));
        const settlementAmountInput = dto.settlementAmount != null
            ? Number(dto.settlementAmount)
            : (dto.settlementBaseAmount != null
                ? Number(dto.settlementBaseAmount)
                : (dto.paidAmount != null ? Number(dto.paidAmount) : Number(dto.receivableAmount ?? 0)));
        const settlementAmount = this.toAmount2(settlementAmountInput);
        const effectiveSettlementAmount = settlementAmount > 0 ? settlementAmount : originalAmount;
        const giftedAmount = isGifted ? originalAmount : 0;
        const isPaid = dto.isGifted ? false : Boolean(dto.isPaid);

        // 统一优惠汇总（先接基础口径，便于后续无缝接优惠券/活动）
        const couponDiscountAmount = selectedUserCoupon
            ? await this.calcCouponDiscount({
                originalAmount,
                projectId: project.id,
                template: selectedUserCoupon.template,
            })
            : this.toAmount2(Number(dto.couponDiscountAmount ?? 0));
        const activityDiscountAmount = this.toAmount2(Number(dto.activityDiscountAmount ?? 0));
        const manualAdjustAmount = this.toAmount2(Number(dto.manualAdjustAmount ?? 0));
        const giftDiscountAmount = this.toAmount2(giftedAmount);
        const discountAmount = this.toAmount2(
            couponDiscountAmount + activityDiscountAmount + giftDiscountAmount + manualAdjustAmount,
        );
        const finalPayableAmount = this.toAmount2(Math.max(0, originalAmount - discountAmount));
        const requestedPaymentChannel = String((dto as any)?.paymentChannel || '').trim().toUpperCase();
        const useMemberBalancePayment =
            scene === 'ADMIN' &&
            !isGifted &&
            isPaid &&
            requestedPaymentChannel === 'BALANCE';
        if (useMemberBalancePayment && !customerUserId) {
            throw new BadRequestException('使用会员储值支付时必须选择会员用户');
        }
        const discountType = this.resolveDiscountType({
            couponDiscountAmount,
            activityDiscountAmount,
            giftDiscountAmount,
            manualAdjustAmount,
        });
        const paidAt = isGifted
            ? null
            : (isPaid
                ? (dto.paymentTime ? new Date(dto.paymentTime) : new Date())
                : (dto.paymentTime ? new Date(dto.paymentTime) : null));
        const paymentChannel = isPaid
            ? (useMemberBalancePayment ? 'BALANCE' : this.resolvePaymentChannelByOrderSource(orderSource))
            : null;
        const discountDetails: Array<{
            sourceType: string;
            sourceId?: number;
            ruleType: string;
            amount: number;
            description: string;
        }> = [];
        if (couponDiscountAmount > 0) {
            discountDetails.push({
                sourceType: 'COUPON',
                sourceId: selectedUserCoupon?.templateId ? Number(selectedUserCoupon.templateId) : undefined,
                ruleType: selectedUserCoupon?.template?.type || 'CASH',
                amount: couponDiscountAmount,
                description: selectedUserCoupon?.template?.name
                    ? `使用优惠券：${selectedUserCoupon.template.name}`
                    : '下单优惠券减免',
            });
        }
        if (activityDiscountAmount > 0) {
            discountDetails.push({
                sourceType: 'ACTIVITY',
                ruleType: 'FULL_REDUCTION',
                amount: activityDiscountAmount,
                description: '活动优惠减免',
            });
        }
        if (giftDiscountAmount > 0) {
            discountDetails.push({
                sourceType: 'GIFT',
                ruleType: 'GIFT',
                amount: giftDiscountAmount,
                description: '赠送单减免',
            });
        }
        if (manualAdjustAmount > 0) {
            discountDetails.push({
                sourceType: 'MANUAL',
                ruleType: 'MANUAL',
                amount: manualAdjustAmount,
                description: '人工优惠减免',
            });
        }

        const order = await this.prisma.$transaction(async (tx) => {
            const createdOrder = await tx.order.create({
                data: {
                    orderQuantity: Number(dto.orderQuantity ?? 1),
                    autoSerial: serial,
                    // ✅ 赠送单不可强制清零金额，清零后结算会产生错误
                    receivableAmount: dto.receivableAmount,
                    paidAmount: dto.paidAmount,
                    settlementBaseAmount: effectiveSettlementAmount,
                    paymentTime: paidAt,
                    isPaid,
                    payStatus: isPaid ? 'SUCCESS' : 'PENDING',
                    // orderTime: dto.orderTime ? new Date(dto.orderTime) : null,
                    orderTime: new Date(),
                    openedAt: new Date(),
                    baseAmountWan: dto.baseAmountWan ?? null,
                    projectId: project.id,
                    projectSnapshot: projectSnapshot as any,
                    customerGameId: dto.customerGameId ?? null,
                    customerUserId,
                    dispatcherId,
                    initialDispatcherId: dispatcherId,
                    orderSource,
                    csRate: dto.csRate ?? defaultCsRate,
                    inviteRate: isRenewal ? 0 : (dto.inviteRate ?? defaultInviteRate),
                    inviter: isRenewal ? null : (dto.inviter ?? null),
                    customClubRate: dto.customClubRate ?? null,
                    clubRate: clubRate ?? null,
                    // ✅ 落库赠送标识
                    isGifted,
                    giftedAmount,
                    originalAmount,
                    discountAmount,
                    couponDiscountAmount,
                    activityDiscountAmount,
                    giftDiscountAmount,
                    manualAdjustAmount,
                    finalPayableAmount,
                    marketingCostAmount: discountAmount,
                    discountType,
                    status: OrderStatus.WAIT_ASSIGN,
                    isRenewal,
                    renewalAmount: 0,
                    renewalCount: 0,
                    ...(discountDetails.length
                        ? {
                            discountDetails: {
                                create: discountDetails,
                            },
                        }
                        : {}),
                },
                include: {
                    project: true,
                    currentDispatch: true,
                    discountDetails: true,
                },
            } as any);

            if (isPaid && !isGifted) {
                let payment: { id: number };
                if (useMemberBalancePayment) {
                    await this.wallet.ensureWalletAccount(Number(customerUserId), tx as any);
                    const account = await tx.walletAccount.findUnique({
                        where: { userId: Number(customerUserId) },
                        select: {
                            availableBalance: true,
                            frozenBalance: true,
                        },
                    });
                    const availableBalance = this.toAmount2(Number(account?.availableBalance ?? 0));
                    const consumeAmount = this.toAmount2(Number(dto.paidAmount ?? 0));
                    if (availableBalance < consumeAmount) {
                        throw new BadRequestException('会员储值余额不足');
                    }

                    const accountAfter = await tx.walletAccount.update({
                        where: { userId: Number(customerUserId) },
                        data: {
                            availableBalance: { decrement: consumeAmount },
                        },
                        select: {
                            availableBalance: true,
                            frozenBalance: true,
                        },
                    });

                    const rewardBaseAmount = this.resolveMemberBenefitBaseAmount({
                        paidAmount: consumeAmount,
                        finalPayableAmount,
                        receivableAmount: Number(dto.receivableAmount ?? consumeAmount),
                        isTestPayment: false,
                    });
                    const rewardPointsPreview = this.getOrderRewardPointsByPaidAmount(rewardBaseAmount);
                    const growthValuePreview = this.getMemberGrowthValueByPaidAmount(rewardBaseAmount);

                    payment = await tx.orderPayment.create({
                        data: {
                            orderId: Number(createdOrder.id),
                            paymentNo: this.buildOrderPaymentNo(String(paymentChannel), Number(createdOrder.id)),
                            channel: 'BALANCE',
                            status: OrderPayStatus.SUCCESS,
                            amount: consumeAmount,
                            currency: 'CNY',
                            paidAt: paidAt || new Date(),
                            notifyRaw: this.buildOrderBalanceReceiptMeta({
                                deductedAmount: consumeAmount,
                                balanceAfter: Number(accountAfter?.availableBalance ?? 0),
                                rewardPoints: rewardPointsPreview,
                                growthValue: growthValuePreview,
                            }) as any,
                        },
                        select: { id: true },
                    });

                    await tx.walletTransaction.create({
                        data: {
                            userId: Number(customerUserId),
                            direction: WalletDirection.OUT,
                            bizType: WalletBizType.MEMBER_ORDER_CONSUME,
                            amount: consumeAmount,
                            status: WalletTxStatus.AVAILABLE,
                            sourceType: 'ORDER_PAYMENT_BALANCE',
                            sourceId: Number(payment.id),
                            orderId: Number(createdOrder.id),
                            availableAfter: Number(accountAfter?.availableBalance ?? 0),
                            frozenAfter: Number(accountAfter?.frozenBalance ?? 0),
                        } as any,
                    });
                } else {
                    payment = await tx.orderPayment.create({
                        data: {
                            orderId: Number(createdOrder.id),
                            paymentNo: this.buildOrderPaymentNo(String(paymentChannel), Number(createdOrder.id)),
                            channel: String(paymentChannel),
                            status: OrderPayStatus.SUCCESS,
                            amount: Number(dto.paidAmount ?? 0),
                            currency: 'CNY',
                            paidAt: paidAt || new Date(),
                        },
                        select: { id: true },
                    });
                }

                await tx.order.update({
                    where: { id: Number(createdOrder.id) },
                    data: {
                        latestPaymentId: payment.id,
                        paymentTime: paidAt || new Date(),
                        isPaid: true,
                        payStatus: OrderPayStatus.SUCCESS,
                    },
                });

                (createdOrder as any).latestPaymentId = payment.id;
                (createdOrder as any).paymentTime = paidAt || new Date();
            }

            if (selectedUserCoupon) {
                const consumeResult = await tx.userCoupon.updateMany({
                    where: {
                        id: Number(selectedUserCoupon.id),
                        status: UserCouponStatus.UNUSED,
                    },
                    data: {
                        status: UserCouponStatus.USED,
                        usedAt: new Date(),
                        orderId: Number(createdOrder.id),
                    },
                });
                if (consumeResult.count !== 1) {
                    throw new ConflictException('优惠券已被使用，请刷新后重试');
                }
                await tx.couponTemplate.update({
                    where: { id: Number(selectedUserCoupon.templateId) },
                    data: { usedCount: { increment: 1 } },
                });
            }
            return createdOrder;
        });

        await this.logOrderAction(operatorId, order.id, 'CREATE_ORDER', {
            autoSerial: order.autoSerial,
            projectId: order.projectId,
            paidAmount: order.paidAmount,
            orderSource,
            paymentChannel,
        });

        // ✅ 新建即派单：若传了 playerIds，则直接创建首轮派单并指派
        if (playerIds.length > 0) {
            // 复用现有派单逻辑（包含防重复、参与者写入、日志等）
            await this.assignDispatch(order.id, playerIds, operatorId, 'AUTO_CREATE', {
                updateOrderDispatcherId: scene !== 'MINIAPP',
                writeOperatorLog: scene !== 'MINIAPP',
                renewalPlayerIds: isRenewal ? renewalPlayerIds : undefined,
                renewalCreatedBy: operatorId,
            });
            // 派单后返回完整详情（带 currentDispatch/participants）
            return this.getOrderDetail(order.id);
        }

        // 未选择打手：保持 WAIT_ASSIGN
        return this.getOrderDetail(order.id);
    }

    /*** -----------------------------
     * 订单列表获取
     * -----------------------------*/
    async listOrders(query: any) {
        const page = query.page ?? 1;
        const limit = query.limit ?? 10;
        const skip = (page - 1) * limit;

        const where: any = {};

        // 你原来的精确/单字段筛选保留
        if (query.serial) where.autoSerial = { contains: query.serial };
        if (query.projectId) where.projectId = query.projectId;
        if (query.status) where.status = query.status as any;
        if (query.dispatcherId) where.dispatcherId = query.dispatcherId;
        if (query.customerGameId) where.customerGameId = { contains: query.customerGameId };
        if (query.orderMonth) {
            const monthText = String(query.orderMonth || '').trim();
            const match = monthText.match(/^(\d{4})-(\d{2})$/);
            if (match) {
                const year = Number(match[1]);
                const month = Number(match[2]);
                const start = new Date(Date.UTC(year, month - 1, 1) - 8 * 60 * 60 * 1000);
                const end = new Date(Date.UTC(year, month, 1) - 8 * 60 * 60 * 1000);
                where.createdAt = { gte: start, lt: end };
            }
        }
        if (query.orderSource) where.orderSource = String(query.orderSource).trim();
        if (query.playerId) {
            where.dispatches = {
                some: { participants: { some: { userId: query.playerId } } },
            };
        }
        if (query.isPaid !== undefined) where.isPaid = query.isPaid === true;

        // ✅ 全局 keyword：订单号 / 客服 / 陪玩昵称
        const keyword = query.keyword?.trim();
        if (keyword) {
            where.OR = [
                // 1) 订单号
                { autoSerial: { contains: keyword } },

                // 2) 客服（dispatcher）
                { dispatcher: { name: { contains: keyword } } },

                // 3) 陪玩昵称（任意历史/当前派单参与者）
                {
                    dispatches: {
                        some: {
                            participants: {
                                some: {
                                    user: { name: { contains: keyword } },
                                },
                            },
                        },
                    },
                },
            ];
        }

        const [rows, total, amountSummary] = await Promise.all([
            this.prisma.order.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
                    autoSerial: true,
                    status: true,
                    orderSource: true,
                    isPaid: true,
                    isGifted: true,
                    receivableAmount: true,
                    paidAmount: true,
                    customerGameId: true,
                    createdAt: true,
                    project: {
                        select: { id: true, name: true },
                    },
                    dispatcher: { select: { id: true, name: true, phone: true, userType: true } },
                    customerUser: { select: { id: true, name: true, phone: true } },
                    currentDispatch: {
                        select: {
                            id: true,
                            status: true,
                            participants: {
                                select: {
                                    id: true,
                                    user: { select: { id: true, name: true, phone: true } },
                                },
                            },
                        },
                    },
                },
            } as any),
            this.prisma.order.count({ where }),
            this.prisma.order.aggregate({
                where,
                _sum: {
                    receivableAmount: true,
                    paidAmount: true,
                },
            } as any),
        ]);

        const optionList = await this.getOrderSourceOptions();
        const sourceLabelMap = new Map(optionList.map((item) => [item.value, item.label]));
        const data = rows.map((row: any) => ({
            ...row,
            orderSource: String(row?.orderSource || '').trim() || 'CUSTOMER_SERVICE_MANUAL',
            orderSourceLabel:
                sourceLabelMap.get(String(row?.orderSource || '').trim() || 'CUSTOMER_SERVICE_MANUAL') || '客服手动派单',
        }));

        return {
            data,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            summary: {
                receivableAmount: this.toAmount2(Number((amountSummary as any)?._sum?.receivableAmount ?? 0)),
                paidAmount: this.toAmount2(Number((amountSummary as any)?._sum?.paidAmount ?? 0)),
            },
        };
    }


    /*** -----------------------------
     * 订单详情方法
     * -----------------------------*/
    /*** -----------------------------
     * 订单详情（含钱包真实收益 & 对账提示）
     * -----------------------------*/

    async getOrderDetail(id: number) {
        // ===========================
        // 1️⃣ 查询订单 + 结算（参考）
        // ===========================
        const order: any = await this.prisma.order.findUnique({
            where: { id },
            include: {
                project: true,
                customerUser: {
                    select: { id: true, name: true, phone: true, avatar: true },
                },
                dispatcher: {
                    select: { id: true, name: true, phone: true, avatar: true, userType: true },
                },

                // ✅ 当前派单批次
                currentDispatch: {
                    include: {
                        participants: {
                            where: { isActive: true },
                            include: {
                                user: {
                                    select: this.getDispatchParticipantUserSelect(),
                                },
                            },
                            orderBy: { id: 'asc' },
                        },
                    },
                },

                // ✅ 历史派单批次
                dispatches: {
                    orderBy: { round: 'desc' },
                    include: {
                        participants: {
                            include: {
                                user: { select: this.getDispatchParticipantUserSelect() },
                            },
                            orderBy: { id: 'asc' },
                        },
                    },
                },

                // ✅ 结算明细（参考口径）
                settlements: {
                    include: {
                        user: { select: { id: true, name: true, phone: true } },
                    },
                    orderBy: { id: 'desc' },
                },
                latestPayment: {
                    select: {
                        channel: true,
                        amount: true,
                        status: true,
                        notifyRaw: true,
                    },
                },
                renewalGroups: {
                    include: {
                        bonuses: {
                            include: {
                                user: { select: { id: true, name: true, phone: true, avatar: true } },
                            },
                            orderBy: { id: 'asc' },
                        },
                    },
                    orderBy: { id: 'desc' },
                },
            },
        } as any);

        if (!order) {
            throw new NotFoundException('订单不存在');
        }

        const shouldKeepDispatchParticipant = (dispatch: any, participant: any) => {
            if (!participant) return false;
            if (participant?.isActive !== false) return true;
            if (participant?.acceptedAt) return true;
            if (participant?.rejectedAt) return true;
            if (Number(participant?.progressBaseWan || 0) > 0) return true;
            if (String(dispatch?.status || '') === DispatchStatus.COMPLETED && (
                participant?.billableHours != null || participant?.billableMinutes != null
            )) return true;
            return false;
        };

        if (Array.isArray(order?.dispatches)) {
            order.dispatches = order.dispatches.map((dispatch: any) => ({
                ...dispatch,
                participants: Array.isArray(dispatch?.participants)
                    ? dispatch.participants.filter((participant: any) => shouldKeepDispatchParticipant(dispatch, participant))
                    : [],
            }));
        }

        const orderStatus = String(order?.status || '').trim().toUpperCase();
        const currentParticipants = Array.isArray(order?.currentDispatch?.participants) ? order.currentDispatch.participants : [];
        if (order?.currentDispatch && (orderStatus === 'COMPLETED_PENDING_CONFIRM' || currentParticipants.length === 0)) {
            const latestDispatch = Array.isArray(order?.dispatches) ? order.dispatches[0] : null;
            const fallbackParticipants = Array.isArray(latestDispatch?.participants)
                ? latestDispatch.participants.filter((p: any) => shouldKeepDispatchParticipant(latestDispatch, p) && !p?.rejectedAt)
                : [];
            if (fallbackParticipants.length) {
                order.currentDispatch = {
                    ...order.currentDispatch,
                    id: latestDispatch?.id ?? order.currentDispatch.id,
                    status: latestDispatch?.status ?? order.currentDispatch.status,
                    participants: fallbackParticipants,
                };
            }
        }

        const activeRenewalBonuses = (Array.isArray(order?.renewalGroups) ? order.renewalGroups : [])
            .filter((group: any) => String(group?.status || '') === 'SETTLED')
            .flatMap((group: any) => Array.isArray(group?.bonuses) ? group.bonuses : [])
            .filter((bonus: any) => String(bonus?.status || '') === 'PAID');
        const activeRenewalWalletTxIds = activeRenewalBonuses
            .map((bonus: any) => Number(bonus?.walletTransactionId || 0))
            .filter((id: number) => Number.isFinite(id) && id > 0);

        // ===========================
        // 2️⃣ 查询钱包真实流水（保留原始有效流水全集）
        // ===========================
        const walletTxs = await this.prisma.walletTransaction.findMany({
            where: {
                OR: [
                    { orderId: id },
                    ...(activeRenewalWalletTxIds.length ? [{ id: { in: activeRenewalWalletTxIds } }] : []),
                ],
                status: { not: 'REVERSED' }, // ❗ 已冲正流水不参与当前统计
            },
            select: {
                userId: true,
                amount: true,
                direction: true, // ✅ 必须
                status: true, // FROZEN / AVAILABLE
                bizType: true,
                // ✅ 直接把用户基础信息带出来
                user: {
                    select: {
                        id: true,
                        name: true,
                        phone: true,
                    },
                },
            },
        });

        // ===========================
        // 2.1️⃣ 对账专用流水筛选
        // ❗ 只统计“真实订单资金贡献”类流水
        // ❗ 排除 RELEASE_FROZEN / 提现类内部迁移
        // ===========================
        const RECONCILE_BIZ_TYPES = new Set([
            'SETTLEMENT_EARNING',
            'SETTLEMENT_EARNING_BASE',
            'SETTLEMENT_EARNING_CARRY',
            'SETTLEMENT_BOMB_LOSS',
            'SETTLEMENT_EARNING_CS',
            'ORDER_RENEWAL_BONUS',
            'ORDER_RENEWAL_BONUS_REVERSAL',
            'REFUND_REVERSAL',
            'SETTLEMENT_REVERSAL',
            'SETTLEMENT_RECALC',
        ]);

        const walletTxsForReconcile = walletTxs.filter((tx) =>
            RECONCILE_BIZ_TYPES.has(String(tx.bizType || '')),
        );

        // ===========================
        // 3️⃣ 钱包收益汇总（真实）- ✅区分 IN / OUT
        // ❗ 改为仅统计对账口径流水，避免 RELEASE_FROZEN 双算
        // ===========================
        let inTotal = 0;      // IN 合计（正数展示）
        let outTotal = 0;     // OUT 合计（正数展示）
        let netTotal = 0;     // 净额（IN - OUT）

        let frozenNet = 0;    // 冻结净额
        let availableNet = 0; // 可用净额

        for (const tx of walletTxsForReconcile) {
            const amt = Number(tx.amount || 0);
            const isOut = tx.direction === 'OUT';
            const signed = isOut ? -amt : amt;

            if (isOut) outTotal += amt;
            else inTotal += amt;

            netTotal += signed;

            if (tx.status === 'FROZEN') frozenNet += signed;
            if (tx.status === 'AVAILABLE') availableNet += signed;
        }

        // 兼容旧变量名：walletTotal = 净额
        const walletTotal = Number(netTotal.toFixed(2));
        const frozen = Number(frozenNet.toFixed(2));
        const available = Number(availableNet.toFixed(2));

        // ===========================
        // 4️⃣ 结算参考汇总
        // ===========================
        const settlementFinalEarningsTotal = order.settlements.reduce(
            (sum, s) => sum + Number(s.finalEarnings || 0),
            0,
        );
        const renewalBonusTotal = activeRenewalBonuses.reduce(
            (sum: number, bonus: any) => sum + Number(bonus?.bonusShareAmount || 0),
            0,
        );
        const settlementTotal = Number((settlementFinalEarningsTotal + renewalBonusTotal).toFixed(2));

        // ===========================
        // 5️⃣ 对账提示（只读）- ✅用净额对账
        // ===========================
        const diff = Number((walletTotal - settlementTotal).toFixed(2));

        let reconcileStatus: 'MATCHED' | 'MISMATCHED' | 'EMPTY';

        if (!order.settlements.length && walletTotal === 0 && inTotal === 0 && outTotal === 0) {
            reconcileStatus = 'EMPTY';
        } else if (diff === 0) {
            reconcileStatus = 'MATCHED';
        } else {
            reconcileStatus = 'MISMATCHED';
        }

        // ===========================
        // ✅ 4.1 结算按人汇总（参考）
        // ===========================
        const settlementByUser = new Map<number, number>();
        const userMap = new Map<number, { id: number; name: string; phone?: string }>();
        for (const s of order.settlements || []) {
            const uid = Number(s?.userId || 0);
            if (!uid) continue;
            const v = Number(s?.finalEarnings || 0);
            settlementByUser.set(uid, (settlementByUser.get(uid) || 0) + v);
            if (s?.user) {
                userMap.set(uid, s.user);
            }
        }
        for (const bonus of activeRenewalBonuses) {
            const uid = Number(bonus?.userId || 0);
            if (!uid) continue;
            const v = Number(bonus?.bonusShareAmount || 0);
            settlementByUser.set(uid, (settlementByUser.get(uid) || 0) + v);
            if (bonus?.user) {
                userMap.set(uid, bonus.user);
            }
        }

        for (const tx of walletTxsForReconcile) {
            if (tx.user) {
                userMap.set(tx.user.id, tx.user);
            }
        }

        // ===========================
        // ✅ 4.2 钱包按人汇总（真实）- ✅区分 IN/OUT/净额
        // ❗ 改为仅统计对账口径流水
        // ===========================
        const walletNetByUser = new Map<number, number>();
        const walletInByUser = new Map<number, number>();
        const walletOutByUser = new Map<number, number>();

        for (const tx of walletTxsForReconcile) {
            const uid = Number(tx?.userId || 0);
            if (!uid) continue;

            const amt = Number(tx?.amount || 0);
            const isOut = tx.direction === 'OUT';
            const signed = isOut ? -amt : amt;

            walletNetByUser.set(uid, (walletNetByUser.get(uid) || 0) + signed);

            if (isOut) walletOutByUser.set(uid, (walletOutByUser.get(uid) || 0) + amt);
            else walletInByUser.set(uid, (walletInByUser.get(uid) || 0) + amt);
        }

        // ===========================
        // ✅ 4.3 合并成“按人对账结果”
        // - 规则：diff = walletNet - settlement
        // ===========================
        const userIds = new Set<number>([
            ...Array.from(settlementByUser.keys()),
            ...Array.from(walletNetByUser.keys()),
        ]);

        const reconcileHintByUser = Array.from(userIds)
            .map((userId) => {
                const settlementTotal = Number((settlementByUser.get(userId) || 0).toFixed(2));

                const walletNet = Number((walletNetByUser.get(userId) || 0).toFixed(2));
                const walletIn = Number((walletInByUser.get(userId) || 0).toFixed(2));
                const walletOut = Number((walletOutByUser.get(userId) || 0).toFixed(2));

                const diff = Number((walletNet - settlementTotal).toFixed(2));

                let status: 'MATCHED' | 'MISMATCHED' | 'EMPTY' = 'MISMATCHED';
                if (settlementTotal === 0 && walletNet === 0 && walletIn === 0 && walletOut === 0) status = 'EMPTY';
                else if (diff === 0) status = 'MATCHED';

                const user = userMap.get(userId);

                // 兼容旧字段 walletTotal（净额），并额外返回 IN/OUT/净额
                return {
                    userId,
                    settlementTotal,
                    userName: user?.name || `#${userId}`,
                    walletTotal: walletNet, // ✅ 兼容旧字段名（语义：净额）
                    walletNet,
                    walletIn,
                    walletOut,
                    diff,
                    status,
                };
            })
            .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

        // ===========================
        // 6️⃣ 返回
        // ===========================
        const orderSourceLabel = await this.resolveOrderSourceLabel((order as any)?.orderSource);

        return {
            ...order,
            orderSourceLabel,

            // ✅ 钱包真实收益概览（增强：IN/OUT/净额）
            walletEarningsSummary: {
                // 兼容旧字段：total/frozen/available（现在表示净额口径）
                total: walletTotal,
                frozen,
                available,

                // 新增：客服友好展示
                inTotal: Number(inTotal.toFixed(2)),
                outTotal: Number(outTotal.toFixed(2)),
                netTotal: walletTotal,
            },

            // ✅ 对账提示（用于 UI / 后续修复入口）
            reconcileHint: {
                status: reconcileStatus,
                settlementTotal,
                settlementFinalEarningsTotal: Number(settlementFinalEarningsTotal.toFixed(2)),
                renewalBonusTotal: Number(renewalBonusTotal.toFixed(2)),
                walletTotal, // ✅ 净额
                diff,        // ✅ 净额 - 结算
            },

            reconcileHintByUser,
        };
    }

    /*** -----------------------------
     * 取消订单方法
     * -----------------------------*/
    async cancelOrder(orderId: number, operatorId: number, remark?: string) {
        if (!orderId) throw new BadRequestException('orderId 必填');

        const order = await this.prisma.order.findUnique({
            where: {id: orderId},
            select: {
                id: true,
                status: true,
                isPaid: true,
                latestPayment: { select: { channel: true, status: true } },
            },
        });

        if (!order) throw new NotFoundException('订单不存在');

        const forbidden = new Set(['COMPLETED', 'REFUNDED']);
        if (forbidden.has(String(order.status))) {
            throw new BadRequestException('当前订单状态不可取消');
        }

        const updated = await this.prisma.order.update({
            where: {id: orderId},
            data: {
                status: OrderStatus.CANCELLED,
            },
        });

        if (operatorId) {
            await this.prisma.userLog.create({
                data: {
                    userId: operatorId,
                    action: 'CANCEL_ORDER',
                    targetType: 'ORDER',
                    targetId: orderId,
                    oldData: {status: order.status} as any,
                    newData: {status: OrderStatus.CANCELLED} as any,
                    remark: remark || '取消订单',
                },
            });
        }

        return updated;
    }

    async deleteOrder(orderId: number, operatorId: number, remark?: string) {
        if (!orderId) throw new BadRequestException('orderId 必填');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                autoSerial: true,
                status: true,
                isPaid: true,
                orderSource: true,
            },
        });

        if (!order) throw new NotFoundException('订单不存在');

        await this.prisma.order.delete({
            where: { id: orderId },
        });

        if (operatorId) {
            await this.prisma.userLog.create({
                data: {
                    userId: operatorId,
                    action: 'DELETE_ORDER',
                    targetType: 'ORDER',
                    targetId: orderId,
                    oldData: order as any,
                    newData: null as any,
                    remark: remark || '删除订单',
                },
            });
        }

        return {
            success: true,
            id: orderId,
            autoSerial: order.autoSerial,
        };
    }

    /*** -----------------------------
     * 派单 / 重新派单（创建新的派单批次）
     *  ARCHIVED 状态也允许再次派单；派单后状态流转与新建订单一致（WAIT_ACCEPT）
     * -----------------------------*/
    async assignDispatch(orderId: number, playerIds: number[], operatorId: number, remark?: string, options?: AssignDispatchOptions) {
        if (!orderId) throw new BadRequestException('orderId 必填');
        if (!Array.isArray(playerIds)) throw new BadRequestException('playerIds 必须为数组');
        playerIds = this.normalizeIdArray(playerIds);
        if (playerIds.length < 1 || playerIds.length > 2) throw new BadRequestException('playerIds 必须为 1~2 个');

        const order = await this.prisma.order.findUnique({
            where: {id: orderId},
            include: {dispatches: {select: {id: true, round: true, status: true}}},
        });

        if (!order) throw new NotFoundException('订单不存在');

        // ✅ 防重复派单：若存在当前派单批次且仍处于待接/已接阶段，则禁止再次创建新一轮派单
        if (order.currentDispatchId) {
            const cur = await this.prisma.orderDispatch.findUnique({
                where: {id: order.currentDispatchId},
                include: {participants: true},
            });

            if (cur && [DispatchStatus.WAIT_ACCEPT, DispatchStatus.ACCEPTED].includes(cur.status as any)) {
                const activeParts = (cur.participants || []).filter((p: any) => p?.isActive !== false);
                // pending：未接单且未拒单
                const hasPending = activeParts.some((p: any) => !p?.acceptedAt && !p?.rejectedAt);
                if (hasPending) {
                    throw new BadRequestException('当前订单存在未完成派单（待接单/已接单），禁止重复派单');
                }
            }
        }

        // ✅ v0.1：允许 WAIT_ASSIGN / ARCHIVED 派单
        // - ARCHIVED：存单后仍保持存单态，但允许创建新 dispatch（round+1），并把 currentDispatch 指向新批次
        const allowOrderStatus = new Set(['WAIT_ASSIGN', 'ARCHIVED']);
        if (!allowOrderStatus.has(String(order.status))) {
            throw new BadRequestException('当前订单状态不可派单');
        }
        if (!this.canDispatchBeforePaid(order) && !order.isPaid) {
            throw new BadRequestException('当前订单未收款，暂不可派单');
        }

        // round 从 1 开始递增
        const nextRound = (order.dispatches?.reduce((max, d) => Math.max(max, d.round), 0) || 0) + 1;
        const renewalPlayerIds = this.normalizeIdArray(options?.renewalPlayerIds);
        if (renewalPlayerIds.length && nextRound !== 1) {
            throw new BadRequestException('续单只能在首轮派单时设置');
        }

        const dispatch = await this.prisma.$transaction(async (tx) => {
            // 创建本轮派单
            const createdDispatch = await tx.orderDispatch.create({
                data: {
                    orderId,
                    round: nextRound,
                    status: 'WAIT_ACCEPT' as any,
                    assignedAt: new Date(),
                    remark: remark || null,
                },
            });

            // 创建参与者
            await tx.orderParticipant.createMany({
                data: playerIds.map((userId) => ({
                    dispatchId: createdDispatch.id,
                    userId,
                    isActive: true,
                })),
            });

            // 更新订单状态 + currentDispatch 指针（状态流转与新建订单一致）
            const updateOrderDispatcherId = options?.updateOrderDispatcherId !== false;

            await tx.order.update({
                where: {id: orderId},
                data: {
                    status: 'WAIT_ACCEPT' as any,
                    currentDispatchId: createdDispatch.id,
                    ...(updateOrderDispatcherId ? { dispatcherId: operatorId || order.dispatcherId } : {}),
                },
            });

            let renewalGroup: any = null;
            if (renewalPlayerIds.length) {
                renewalGroup = await this.createRenewalGroupTx({
                    tx,
                    orderId,
                    dispatchId: createdDispatch.id,
                    playerIds,
                    renewalPlayerIds,
                    operatorId: Number(options?.renewalCreatedBy || operatorId || 0),
                });
            }

            // 记录日志
            if (options?.writeOperatorLog !== false && operatorId) {
                await tx.userLog.create({
                    data: {
                        userId: operatorId,
                        action: 'ASSIGN_DISPATCH',
                        targetType: 'ORDER',
                        targetId: orderId,
                        oldData: {status: order.status} as any,
                        newData: {
                            status: 'WAIT_ACCEPT',
                            playerIds,
                            round: nextRound,
                            renewalGroupId: renewalGroup?.id ?? null,
                            renewalPlayerIds: renewalPlayerIds.length ? renewalPlayerIds : undefined,
                        } as any,
                        remark: remark || `派单 round=${nextRound}`,
                    },
                });
            }

            return createdDispatch;
        });

        // 派单成功后给对应打手推送接单通知（通知失败不影响主流程）
        try {
            await this.notificationsService.pushDispatchAssigned({
                orderId,
                dispatchId: dispatch.id,
                playerIds,
                autoSerial: (order as any).autoSerial || undefined,
            });
        } catch (e) {
            console.error('[notify][dispatch-assigned] failed', e?.message || e);
        }

        return this.getOrderDetail(orderId);
    }

    /*** -----------------------------
     * 打手存单/结单（ARCHIVED）——本轮只需正常存单
     * -----------------------------*/
    async archiveDispatch(dispatchStatus: DispatchStatus, dispatchId: number, user: any, dto: any) {
        return this.archiveDispatchWithOptions(dispatchStatus, dispatchId, user, dto, {});
    }

    private async archiveDispatchWithOptions(
        dispatchStatus: DispatchStatus,
        dispatchId: number,
        user: any,
        dto: any,
        options: ArchiveDispatchOptions,
    ) {
        const operatorId: number = user.userId
        const requiredRemark = options.forceByAdmin
            ? this.normalizeRequiredRemark(dto?.remark, `客服${dispatchStatus === DispatchStatus.ARCHIVED ? '存单' : '结单'}请填写处理原因`)
            : String(dto?.remark || '').trim() || undefined;
        const orderId = await this.prisma.$transaction(async (tx) => {
            await this.lockDispatchForSettlementOrThrow(dispatchId, tx, options.forceByAdmin === true);
            try {
                const dispatch = await tx.orderDispatch.findUnique({
                    where: {id: dispatchId},
                    include: {
                        order: {include: {project: true}},
                        participants: true,
                    },
                });
                if (!dispatch) throw new BadRequestException('派单批次不存在');

                // ✅ 1) 权限校验：必须是参与者（最小实现：只允许参与者存单）
                // 严格要求“当前轮 + 仍有效参与者”，防止被替换打手继续操作
                if (Number(dispatch.order.currentDispatchId || 0) !== Number(dispatch.id)) {
                    throw new BadRequestException('当前派单已更新，请刷新后再操作');
                }
                const isParticipant = dispatch.participants?.some((p) => (
                    Number(p.userId) === Number(operatorId)
                    && p.isActive !== false
                    && !p.rejectedAt
                ));
                if (!isParticipant && !options.forceByAdmin) throw new BadRequestException('你不是本轮派单参与者，无权操作');

                // ✅ 2) 防重复（可选但建议）
                if (dispatch.status === dispatchStatus) {
                    throw new BadRequestException(`该派单已${dispatchStatus === 'ARCHIVED' ? '存' : '结'}单，无需重复操作`);
                }

                const snap = dispatch?.order?.projectSnapshot as any;
                const orderClass: string | null =
                    dispatch.order?.project?.billingMode ??
                    (snap && typeof snap === 'object' && !Array.isArray(snap) ? (snap.billingMode ?? null) : null);
                if (!orderClass) throw new BadRequestException('订单类型有误，无法操作，请联系管理员！');

                // HOURLY: 小时单
                // GUARANTEED: 保底单
                // MODE_PLAY: 玩法单

                // ✅ 3) 按单型写入“本次存单口径数据”
                // if (orderClass === 'HOURLY') {}
                if (orderClass === 'GUARANTEED') {
                    const progresses = dto.progresses ?? [];
                    for (const p of progresses) {
                        const userId = Number(p?.userId);
                        if (!Number.isFinite(userId) || userId <= 0) continue;

                        await tx.orderParticipant.updateMany({
                            where: {
                                dispatchId,
                                userId,
                                isActive: true, // ✅ 修正：更新当前活跃参与者
                            },
                            data: {
                                progressBaseWan: roundMix1(p?.progressBaseWan),
                                isActive: false, // ✅ 同时置失效
                            },
                        });
                    }
                } else { //小时单 玩法单，直接置为存/结单。更新状态
                    const progresses = dto.progresses ?? [];
                    for (const p of progresses) {
                        const userId = Number(p?.userId);
                        if (!Number.isFinite(userId) || userId <= 0) continue;

                        await tx.orderParticipant.updateMany({
                            where: {
                                dispatchId,
                                userId,
                                isActive: true, // ✅ 修正：更新当前活跃参与者
                            },
                            data: {
                                isActive: false, // ✅ 同时置失效
                            },
                        });
                    }
                }

                const now = new Date();
                if (options.forceByAdmin) {
                    await tx.orderParticipant.updateMany({
                        where: {
                            dispatchId,
                            isActive: true,
                            rejectedAt: null,
                            acceptedAt: null,
                        },
                        data: {
                            acceptedAt: now,
                        },
                    });
                }

                const currentParticipants = (dispatch.participants || []).filter((p: any) => {
                    const userId = Number(p?.userId ?? 0);
                    return Number.isFinite(userId) && userId > 0 && p?.isActive !== false && !p?.rejectedAt;
                });
                if (!currentParticipants.length) {
                    throw new BadRequestException('当前派单没有有效打手，无法存/结单，请先重新派单或调整打手');
                }

                // ✅ 4) 派单置存/结单
                await tx.orderDispatch.update({
                    where: {id: dispatchId},
                    data: {
                        status: dispatchStatus,
                        archivedAt: now,
                        completedAt: dispatchStatus === 'COMPLETED' ? now : null,
                        remark: requiredRemark ?? dispatch.remark ?? null,
                        ...(orderClass === 'HOURLY'
                            ? {
                                deductMinutesValue:
                                    dto.deductMinutesValue === undefined || dto.deductMinutesValue === null
                                        ? null
                                        : Math.max(0, Math.floor(Number(dto.deductMinutesValue))),

                                billableMinutes:
                                    dto.billableMinutes === undefined || dto.billableMinutes === null
                                        ? null
                                        : Math.max(0, Math.floor(Number(dto.billableMinutes))),

                                billableHours:
                                    dto.billableHours === undefined || dto.billableHours === null
                                        ? null
                                        : Number(dto.billableHours),
                            }
                            : {}),
                    },
                });
                // ✅ 5) 订单置存单
                await tx.order.update({
                    where: {id: dispatch.orderId},
                    data: {status: dispatchStatus === 'COMPLETED' ? OrderStatus.COMPLETED_PENDING_CONFIRM : OrderStatus.ARCHIVED},
                });

                // ⚠️ 6) 释放参与者状态：这是运营副作用，你现在保留也行
                // 但更严谨是仅释放本轮参与者（你现在就是 participants）
                const userIds = dispatch.participants.map((p) => p.userId);
                await tx.user.updateMany({
                    where: {id: {in: userIds}},
                    data: {workStatus: 'IDLE' as any},
                });
                // ✅ 7) 写日志：记录“谁、什么时候、存的什么”
                await this.logOrderAction(
                    operatorId,
                    dispatch.orderId,
                    options.forceByAdmin ? 'ADMIN_ARCHIVE_DISPATCH' : 'ARCHIVE_DISPATCH',
                    {
                        dispatchId,
                        archivedAt: now.toISOString(),
                        orderClass,
                        forceByAdmin: Boolean(options.forceByAdmin),
                        remark: requiredRemark ?? null,
                        // 保底单关键数据：把前端传入的 progresses 原样记录（或记录 normalize 后也行）
                        progresses: orderClass === 'GUARANTEED' ? (dto.progresses ?? []) : undefined,
                        // 小时单关键数据：你算出来的 minutes/hours 也建议塞这里（你现在还没接上）
                    },
                    tx,
                    `用户(${user.name})进行${dispatchStatus === 'ARCHIVED' ? '存' : '结'}单操作`,
                );
                return dispatch.orderId;
            } catch (e) {
                // ✅ 失败释放锁：仅当还处于 SETTLING 才回滚
                await tx.orderDispatch.updateMany({
                    where: {id: dispatchId, status: DispatchStatus.SETTLING},
                    data: {status: DispatchStatus.ACCEPTED},
                });

                // ✅ 关键：必须 rethrow，保证事务整体回滚
                throw e;
            }
        }, {maxWait: 5000, timeout: 20000});

        // 打手存单/结单后给当班客服推送（通知失败不影响主流程）
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: Number(orderId) },
                select: { autoSerial: true },
            });

            await this.notificationsService.pushDispatchArchiveOrCompleteToDutyCs({
                orderId: Number(orderId),
                dispatchId,
                autoSerial: order?.autoSerial || undefined,
                status: dispatchStatus === DispatchStatus.COMPLETED ? 'COMPLETED' : 'ARCHIVED',
            });
        } catch (e) {
            console.error('[notify][dispatch-archive-complete] failed', e?.message || e);
        }

        return {
            code: 200,
            msg: `${dispatchStatus === 'ARCHIVED' ? '存' : '结'}单成功`,
            orderId
        };
    }

    /*** -----------------------------
     * 小时单补收（只修改收款口径，不触发结算重算）。
     * ✅ 仅“已结单待确认”阶段允许补收（OrderStatus.COMPLETED_PENDING_CONFIRM）
     * ✅ 仅小时单（BillingMode.HOURLY）
     * ✅ 实付金额仅允许增加（超时补收），不允许减少
     *
     * 兼容：先打后付的收款逻辑
     * - 如果订单当前未付款（isPaid=false），补收时默认一并标记已付款（isPaid=true、paymentTime=now）
     * - 前端可传 confirmPaid=false 显式取消（checkbox 取消勾选）
     * - 已付款订单不覆盖 paymentTime，避免历史付款时间被误改
     * - 允许 body 传 string/boolean，内部统一转 boolean
     **/
    async updatePaidAmount(orderId: number, paidAmount: number, operatorId: number, remark?: string, confirmPaid?: any,) {
        if (!orderId) throw new BadRequestException('id 必填');
        if (!Number.isFinite(paidAmount) || paidAmount < 0) throw new BadRequestException('paidAmount 非法');

        const result = await this.prisma.$transaction(async (tx) => {
            // 1) 读取订单（事务内）
            const order = await tx.order.findUnique({
                where: {id: orderId},
                include: {project: true},
            });
            if (!order) throw new NotFoundException('订单不存在');


            await this.assertOrderNotSettlingOrThrow(tx, orderId, '订单正在结算处理中，请稍后再试');

            await this.applyPaidAmountUpdateInTx(tx, order, paidAmount, operatorId, remark, confirmPaid);

            // ✅ 不重算、不动钱包
            return tx.order.findUnique({where: {id: orderId}});
        });

        return result;
    }

    /*** -----------------------------
     * 更新参与者；前端目前是存单模式下调用 todo 1-24 需优化，同派单方法一致即可
     * --------------------------*/
    async updateDispatchParticipants(
        dto: { dispatchId: number; playerIds: number[]; remark?: string },
        operatorId: number,
    ) {
        const dispatchId = Number(dto?.dispatchId);
        operatorId = Number(operatorId);

        if (!dispatchId) throw new BadRequestException('dispatchId 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');

        const targetUserIds = Array.isArray(dto?.playerIds)
            ? dto.playerIds.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
            : [];

        if (targetUserIds.length <= 0) {
            throw new BadRequestException('参与者不能为空');
        }

        const target = Array.from(new Set<number>(targetUserIds));
        const now = new Date();

        let finalDispatchId = dispatchId;
        let finalOrderId: number | null = null;

        await this.prisma.$transaction(async (tx) => {
            const dispatch = await tx.orderDispatch.findUnique({
                where: {id: dispatchId},
                include: {
                    order: {select: {id: true, status: true}},
                    participants: true,
                },
            });

            if (!dispatch) throw new NotFoundException('派单批次不存在');

            finalOrderId = Number(dispatch.orderId);
            const currentDispatchId = Number((dispatch.order as any)?.currentDispatchId || dispatchId);
            if (currentDispatchId !== Number(dispatchId)) {
                throw new BadRequestException('当前派单已更新，请刷新后重试');
            }

            const allParticipants = Array.isArray(dispatch.participants) ? dispatch.participants : [];
            const activeParticipants = allParticipants.filter((p: any) => p?.isActive !== false);
            const acceptedActiveParticipants = activeParticipants.filter((p: any) => !!p?.acceptedAt && !p?.rejectedAt);

            // 锁轮判断：
            // - 非 WAIT_ACCEPT：必须新建一轮
            // - 出现过拒单：必须新建一轮，避免把已拒单历史重新揉回当前轮
            // - 仅“部分接单”场景允许原轮替换未接单参与者
            const hasAccepted = acceptedActiveParticipants.length > 0;
            const hasRejected = allParticipants.some((p: any) => !!p?.rejectedAt);

            const shouldCreateNewRound =
                dispatch.status !== DispatchStatus.WAIT_ACCEPT || hasRejected;

            if (shouldCreateNewRound) {
                const oldActiveUserIds = activeParticipants.map((p: any) => Number(p.userId));
                // 1) 旧轮次不再是 latest（如果你确实有 isLatest 字段）
                //    注意：如果你没有 isLatest 字段，请删除这一段
                try {
                    await tx.orderDispatch.update({
                        where: {id: dispatchId},
                        data: {isLatest: false} as any,
                    });
                } catch (e) {
                    // 如果 schema 没有 isLatest，避免事务直接炸（你可以删掉 try/catch 改为显式字段）
                }

                // 2) 旧轮有效参与者归档，避免继续以旧轮操作
                await tx.orderParticipant.updateMany({
                    where: { dispatchId, isActive: true },
                    data: { isActive: false },
                });

                // 3) 新建一轮派单
                const nextRound = (Number((dispatch as any).round || 0) || 0) + 1;
                const newDispatch = await tx.orderDispatch.create({
                    data: {
                        orderId: dispatch.orderId,
                        round: nextRound,
                        status: DispatchStatus.WAIT_ACCEPT,
                        assignedAt: now,
                        remark: dto?.remark ?? null,
                        isLatest: true,
                    } as any,
                });

                finalDispatchId = Number(newDispatch.id);

                // 4) 给新轮次写入参与者
                await tx.orderParticipant.createMany({
                    data: target.map((uid) => ({
                        dispatchId: newDispatch.id,
                        userId: uid,
                        isActive: true,
                    })),
                    skipDuplicates: true,
                });

                // 5) 切到新轮次，订单状态回到待接单
                await tx.order.update({
                    where: { id: dispatch.orderId },
                    data: {
                        status: OrderStatus.WAIT_ACCEPT,
                        currentDispatchId: newDispatch.id,
                    },
                });

                // 6) 刷新旧参与者工作状态（避免被替换后仍卡 WORKING）
                await this.refreshPlayerWorkStatusByActiveAcceptedDispatches(tx, oldActiveUserIds);

                // 7) 记录日志
                await this.logOrderAction(operatorId, dispatch.orderId, 'CREATE_NEW_DISPATCH_AND_SET_PARTICIPANTS', {
                    fromDispatchId: dispatchId,
                    toDispatchId: newDispatch.id,
                    targetUserIds: target,
                    oldActiveUserIds,
                    reason: {
                        status: dispatch.status,
                        hasAccepted,
                        hasRejected,
                    },
                    remark: dto?.remark ?? null,
                    at: now,
                });

                return;
            }

            // ✅ 否则：仍在 WAIT_ACCEPT，且没有发生过拒单
            // - 无人接单：允许普通改派
            // - 已有人接单：仅允许保留已接单的人，替换未接单的人
            // 不能“全量失效+createMany(skipDuplicates)”；否则同一 user 会因唯一键无法重建活跃记录。
            // 改为：按 userId 差量更新（保留/移除/新增）保证同一参与者可安全改派。
            const activeUserIds = Array.from(new Set(activeParticipants.map((p: any) => Number(p.userId))));
            const targetSet = new Set(target);
            const toDisable = activeUserIds.filter((uid) => !targetSet.has(uid));

            if (hasAccepted) {
                const acceptedUserIds = acceptedActiveParticipants.map((p: any) => Number(p.userId));
                const missingAccepted = acceptedUserIds.filter((uid: number) => !targetSet.has(uid));
                if (missingAccepted.length > 0) {
                    throw new BadRequestException('已有打手接单，仅支持替换未接单参与者');
                }
            }

            const removablePendingParticipants = activeParticipants.filter((p: any) => (
                toDisable.includes(Number(p.userId))
                && !p?.acceptedAt
                && !p?.rejectedAt
            ));
            const invalidRemovedParticipants = activeParticipants.filter((p: any) => (
                toDisable.includes(Number(p.userId))
                && (!!p?.acceptedAt || !!p?.rejectedAt)
            ));
            if (invalidRemovedParticipants.length > 0) {
                throw new BadRequestException('当前仅支持替换未接单参与者');
            }

            if (removablePendingParticipants.length > 0) {
                await tx.orderParticipant.deleteMany({
                    where: {
                        id: { in: removablePendingParticipants.map((p: any) => Number(p.id)).filter((id: number) => Number.isFinite(id) && id > 0) },
                    },
                });
            }

            // 对目标参与者做 upsert，兼容“同一人重新指派”
            for (const uid of target) {
                const existing = allParticipants.find((p: any) => Number(p.userId) === Number(uid));
                if (existing?.acceptedAt) {
                    continue;
                }
                await tx.orderParticipant.upsert({
                    where: {
                        dispatchId_userId: {
                            dispatchId,
                            userId: uid,
                        },
                    },
                    update: {
                        isActive: true,
                        // 被重新纳入时，恢复可接单状态
                        acceptedAt: null,
                        rejectedAt: null,
                        rejectReason: null,
                    } as any,
                    create: {
                        dispatchId,
                        userId: uid,
                        isActive: true,
                    },
                });
            }

            await this.logOrderAction(operatorId, dispatch.orderId, 'UPDATE_DISPATCH_PARTICIPANTS', {
                dispatchId,
                beforeActiveUserIds: activeUserIds,
                removedUserIds: removablePendingParticipants.map((p: any) => Number(p.userId)),
                acceptedUserIds: acceptedActiveParticipants.map((p: any) => Number(p.userId)),
                targetUserIds: target,
                remark: dto?.remark ?? null,
                at: now,
            });

            // 本轮仍是当前轮，确保订单状态保持待接单
            await tx.order.update({
                where: { id: dispatch.orderId },
                data: { status: OrderStatus.WAIT_ACCEPT, currentDispatchId: dispatchId },
            });

            // 同步被移除参与者的工作状态，避免“已被替换但仍无法再次派单”
            await this.refreshPlayerWorkStatusByActiveAcceptedDispatches(
                tx,
                removablePendingParticipants.map((p: any) => Number(p.userId)),
            );
        });

        // 返回订单详情，供前端刷新
        if (!finalOrderId) {
            const after = await this.prisma.orderDispatch.findUnique({
                where: {id: finalDispatchId},
                select: {orderId: true},
            });
            finalOrderId = Number(after?.orderId);
        }

        // ✅ 关键修复：
        // updateDispatchParticipants（改派/重派）之前未触发“已派单待接单”消息，
        // 导致打手侧实时消息中心收不到派单通知。
        // 这里补齐与 assignDispatch 一致的推送行为。
        try {
            const order = await this.prisma.order.findUnique({
                where: { id: Number(finalOrderId) },
                select: { autoSerial: true },
            });

            await this.notificationsService.pushDispatchAssigned({
                orderId: Number(finalOrderId),
                dispatchId: Number(finalDispatchId),
                playerIds: target,
                autoSerial: order?.autoSerial || undefined,
            });
        } catch (e) {
            console.error('[notify][update-dispatch-participants] failed', e?.message || e);
        }

        try {
            await this.miniSubscribeMessageService.pushOrderProgressMessage(
                Number(finalOrderId),
                '订单已派单，请留意接单与服务进度',
                '待接单',
            );
        } catch (e: any) {
            console.error('[notify][mini-order-progress][update-dispatch-participants] failed', e?.message || e);
        }

        return this.getOrderDetail(Number(finalOrderId));
    }

    /*** -----------------------------
     * 结算手动调整（管理端/财务） todo 1-24 即将废弃，前提是需上线重新结算，且不允许所有订单类型可手动调整
     * --------------------------*/
    async adjustSettlementFinalEarnings(dto: { settlementId: number; finalEarnings: number; remark?: string }, operatorId: number,) {
        const settlementId = Number(dto.settlementId);
        const finalEarnings = Number(dto.finalEarnings);

        if (!settlementId) throw new BadRequestException('settlementId 必填');
        if (!Number.isFinite(finalEarnings)) throw new BadRequestException('finalEarnings 非法');

        const result = await this.prisma.$transaction(async (tx) => {
            const s = await tx.orderSettlement.findUnique({
                where: {id: settlementId},
                select: {
                    id: true,
                    orderId: true,
                    dispatchId: true,
                    userId: true,
                    settlementType: true,
                    calculatedEarnings: true,
                    finalEarnings: true,
                    manualAdjustment: true,
                    order: {
                        select: {
                            id: true,
                            autoSerial: true,
                            settlementBaseAmount: true,
                            paidAmount: true,
                            receivableAmount: true,
                            originalAmount: true,
                        },
                    },
                },
            });
            if (!s) throw new NotFoundException('结算记录不存在');

            // ===========================
            // ✅ 校验：已解冻/不冻结则禁止调整
            // ===========================
            const earningTx = await tx.walletTransaction.findUnique({
                where: {
                    sourceType_sourceId: {
                        sourceType: 'ORDER_SETTLEMENT',
                        sourceId: settlementId,
                    },
                },
                select: {id: true, status: true},
            });

            // 兼容历史：如果没有 walletTx（老数据），允许调整（并会在同步方法里补建）
            if (earningTx) {
                if (earningTx.status !== 'FROZEN') {
                    throw new BadRequestException('该结算已解冻/已入账，禁止手动调整');
                }

                const hold = await tx.walletHold.findUnique({
                    where: {earningTxId: earningTx.id},
                    select: {status: true},
                });

                // 若 hold 存在且不是 FROZEN，也视为已解冻/不可调整
                if (hold && hold.status !== 'FROZEN') {
                    throw new BadRequestException('该结算已解冻/已入账，禁止手动调整');
                }
            }

            // ===========================
            // 1) 更新结算记录
            // ===========================
            const calculated = Number(s.calculatedEarnings ?? 0);
            const manualAdjustment = finalEarnings - calculated;

            const orderSettlements = await tx.orderSettlement.findMany({
                where: { orderId: Number(s.orderId) },
                select: { id: true, finalEarnings: true, settlementType: true },
            });
            const adjustedRows = orderSettlements.map((row: any) => (
                Number(row.id) === settlementId
                    ? { ...row, finalEarnings }
                    : row
            ));
            this.assertOrderSettlementPayoutWithinBase({
                order: s.order,
                settlements: adjustedRows,
                context: '人工调整结算收益',
            });

            const updated = await tx.orderSettlement.update({
                where: {id: settlementId},
                data: {
                    finalEarnings,
                    manualAdjustment,

                    // 如果你 schema 里有这些字段就保留；没有就删掉
                    adjustedBy: operatorId,
                    adjustedAt: new Date(),
                    adjustRemark: dto.remark ? `MANUAL_ADJUST:${dto.remark}` : 'MANUAL_ADJUST',
                } as any,
            });

            // ===========================
            // 2) 同步钱包（关键）
            // ✅ 正数：冻结
            // ✅ 负数：即时扣款（availableBalance 立即变化）
            // ✅ 0：释放冻结并不影响余额
            // ===========================
            // 解冻时间：手工调整不应改变 unlockAt
            // - 若已有 hold，用原 unlockAt
            // - 若无 hold 且 final>0，需要一个 unlockAt（这里用 now，满足“先满足需求”）
            let unlockAt = new Date();
            if (earningTx?.id) {
                const hold = await tx.walletHold.findUnique({
                    where: {earningTxId: earningTx.id},
                    select: {unlockAt: true},
                });
                if (hold?.unlockAt) unlockAt = hold.unlockAt;
            }

            await this.wallet.syncSettlementEarningByFinalEarnings(
                {
                    userId: s.userId,
                    finalEarnings,
                    unlockAt,
                    sourceType: 'ORDER_SETTLEMENT',
                    sourceId: settlementId,
                    orderId: s.orderId,
                    dispatchId: s.dispatchId ?? null,
                    settlementId: settlementId,
                },
                tx as any,
            );

            // ✅ 日志
            await this.logOrderAction(operatorId, s.orderId, 'ADJUST_SETTLEMENT', {
                settlementId,
                targetUserId: s.userId,
                settlementType: s.settlementType,
                oldFinalEarnings: s.finalEarnings,
                newFinalEarnings: finalEarnings,
                manualAdjustment,
                remark: dto.remark ?? null,
            });

            return updated;
        });

        return result;
    }



    private isComplaintRefundSupportedChannel(channel?: string | null) {
        const c = String(channel || '').trim().toUpperCase();
        return c === 'MINIAPP_WECHAT' || c === 'WECHAT' || c === 'BALANCE';
    }

    private getComplaintRefundUnsupportedReason(channel?: string | null) {
        return this.isComplaintRefundSupportedChannel(channel)
            ? null
            : '退款仅支持原路退回，代付下单等不支持售后退款';
    }

    private getComplaintSuggestedRefundAmount(paidAmount: number) {
        return this.toAmount2(this.toAmount2(Number(paidAmount || 0)) * 0.7);
    }

    private buildComplaintTicketNo(orderId: number) {
        return `KP-${orderId}-${Date.now()}`;
    }

    private normalizeComplaintWorkOrderRow(row: any) {
        if (!row) return null;
        return {
            ...row,
            id: Number(row.id),
            orderId: Number(row.orderId),
            userId: Number(row.userId),
            refundSupported: Boolean(Number(row.refundSupported || 0)),
            suggestedRefundAmount:
                row.suggestedRefundAmount === null || row.suggestedRefundAmount === undefined
                    ? null
                    : this.toAmount2(Number(row.suggestedRefundAmount)),
            approvedRefundAmount:
                row.approvedRefundAmount === null || row.approvedRefundAmount === undefined
                    ? null
                    : this.toAmount2(Number(row.approvedRefundAmount)),
            reviewedBy: row.reviewedBy == null ? null : Number(row.reviewedBy),
            refundedBy: row.refundedBy == null ? null : Number(row.refundedBy),
        };
    }

    private async findComplaintWorkOrderById(db: any, id: number) {
        const rows = await db.$queryRawUnsafe(
            'SELECT * FROM complaint_work_orders WHERE id = ? LIMIT 1',
            Number(id),
        );
        return this.normalizeComplaintWorkOrderRow(rows?.[0]);
    }

    private async findComplaintWorkOrderByOrderId(db: any, orderId: number) {
        const rows = await db.$queryRawUnsafe(
            'SELECT * FROM complaint_work_orders WHERE orderId = ? ORDER BY id DESC LIMIT 1',
            Number(orderId),
        );
        return this.normalizeComplaintWorkOrderRow(rows?.[0]);
    }

    private async updateComplaintWorkOrderTx(db: any, id: number, patch: Record<string, any>) {
        const allowedColumns = new Set([
            'status',
            'reason',
            'description',
            'paymentChannel',
            'refundSupported',
            'refundUnsupportedReason',
            'suggestedRefundAmount',
            'approvedRefundAmount',
            'reviewRemark',
            'refundRemark',
            'reviewedBy',
            'reviewedAt',
            'refundedBy',
            'refundedAt',
        ]);
        const entries = Object.entries(patch || {}).filter(([, value]) => value !== undefined);
        if (!entries.length) return this.findComplaintWorkOrderById(db, id);
        const sets: string[] = [];
        const values: any[] = [];
        for (const [key, rawValue] of entries) {
            if (!allowedColumns.has(key)) {
                throw new BadRequestException('客诉工单更新字段不合法');
            }
            let value = rawValue;
            if (typeof value === 'boolean') value = value ? 1 : 0;
            if (value && typeof value === 'object' && !(value instanceof Date)) value = JSON.stringify(value);
            sets.push(`\`${key}\` = ?`);
            values.push(value);
        }
        sets.push('`updatedAt` = NOW()');
        await db.$executeRawUnsafe(
            `UPDATE complaint_work_orders SET ${sets.join(', ')} WHERE id = ?`,
            ...values,
            Number(id),
        );
        return this.findComplaintWorkOrderById(db, id);
    }

    private async createComplaintWorkOrderTx(db: any, payload: {
        orderId: number;
        userId: number;
        status: string;
        reason: string;
        description?: string | null;
        paymentChannel?: string | null;
        refundSupported: boolean;
        refundUnsupportedReason?: string | null;
        suggestedRefundAmount?: number | null;
    }) {
        const ticketNo = this.buildComplaintTicketNo(payload.orderId);
        await db.$executeRawUnsafe(
            `INSERT INTO complaint_work_orders (
                ticketNo, orderId, userId, status, reason, description,
                paymentChannel, refundSupported, refundUnsupportedReason,
                suggestedRefundAmount, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            ticketNo,
            Number(payload.orderId),
            Number(payload.userId),
            String(payload.status || 'PENDING_REVIEW'),
            String(payload.reason || '').trim(),
            payload.description ? String(payload.description).trim() : null,
            payload.paymentChannel ? String(payload.paymentChannel).trim().toUpperCase() : null,
            payload.refundSupported ? 1 : 0,
            payload.refundUnsupportedReason ? String(payload.refundUnsupportedReason).trim() : null,
            payload.suggestedRefundAmount == null ? null : this.toAmount2(Number(payload.suggestedRefundAmount)),
        );
        const rows = await db.$queryRawUnsafe(
            'SELECT * FROM complaint_work_orders WHERE orderId = ? ORDER BY id DESC LIMIT 1',
            Number(payload.orderId),
        );
        return this.normalizeComplaintWorkOrderRow(rows?.[0]);
    }

    private async getComplaintOrderMap(orderIds: number[]) {
        const ids = Array.from(new Set((orderIds || []).map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0)));
        if (!ids.length) return new Map<number, any>();
        const orders = await this.prisma.order.findMany({
            where: { id: { in: ids } },
            select: {
                id: true,
                autoSerial: true,
                paidAmount: true,
                receivableAmount: true,
                finalPayableAmount: true,
                status: true,
                createdAt: true,
                customerUser: { select: { id: true, name: true, phone: true } },
                latestPayment: { select: { channel: true, status: true, amount: true, paidAt: true } },
                project: { select: { id: true, name: true, coverImage: true } },
            },
        });
        return new Map<number, any>(orders.map((item: any) => [Number(item.id), item]));
    }

    private buildComplaintWorkOrderView(row: any, order?: any) {
        const complaint = this.normalizeComplaintWorkOrderRow(row);
        if (!complaint) return null;
        const paidAmount = this.toAmount2(Number(order?.paidAmount ?? order?.latestPayment?.amount ?? order?.finalPayableAmount ?? order?.receivableAmount ?? 0));
        return {
            ...complaint,
            order: order
                ? {
                      id: Number(order.id),
                      orderNo: String(order.autoSerial || `#${order.id}`),
                      serviceName: String(order?.project?.name || '--'),
                      coverImage: String(order?.project?.coverImage || ''),
                      amount: paidAmount,
                      status: String(order.status || ''),
                      createdAt: order.createdAt,
                      customerName: String(order?.customerUser?.name || '--'),
                      customerPhone: String(order?.customerUser?.phone || ''),
                      paymentChannel: String(order?.latestPayment?.channel || complaint.paymentChannel || ''),
                      paymentStatus: String(order?.latestPayment?.status || ''),
                      paidAt: order?.latestPayment?.paidAt || null,
                  }
                : null,
        };
    }

    async getComplaintWorkOrderByOrderIdForMini(orderId: number, userId: number) {
        orderId = Number(orderId);
        userId = Number(userId);
        const order = await this.prisma.order.findFirst({
            where: { id: orderId, customerUserId: userId },
            select: {
                id: true,
                autoSerial: true,
                paidAmount: true,
                receivableAmount: true,
                finalPayableAmount: true,
                status: true,
                createdAt: true,
                customerUser: { select: { id: true, name: true, phone: true } },
                latestPayment: { select: { channel: true, status: true, amount: true, paidAt: true } },
                project: { select: { id: true, name: true, coverImage: true } },
            },
        });
        if (!order) throw new NotFoundException('订单不存在');
        const complaint = await this.findComplaintWorkOrderByOrderId(this.prisma, orderId);
        return {
            order: this.buildComplaintWorkOrderView({ orderId }, order)?.order || null,
            complaint: complaint ? this.buildComplaintWorkOrderView(complaint, order) : null,
        };
    }

    async submitComplaintWorkOrderFromMini(orderId: number, userId: number, body: any) {
        orderId = Number(orderId);
        userId = Number(userId);
        const reason = String(body?.reason || '').trim();
        if (!reason) throw new BadRequestException('reason 必填');
        const description = body?.description ? String(body.description).trim() : '';

        const order = await this.prisma.order.findFirst({
            where: { id: orderId, customerUserId: userId },
            select: {
                id: true,
                autoSerial: true,
                paidAmount: true,
                receivableAmount: true,
                finalPayableAmount: true,
                status: true,
                createdAt: true,
                customerUser: { select: { id: true, name: true, phone: true } },
                latestPayment: { select: { channel: true, status: true, amount: true, paidAt: true } },
                project: { select: { id: true, name: true, coverImage: true } },
            },
        });
        if (!order) throw new NotFoundException('订单不存在');

        const allowed = new Set(['COMPLETED', 'REVIEWED', 'WAIT_AFTERSALE', 'AFTERSALE_DONE']);
        const currentStatus = String(order.status || '').toUpperCase();
        if (!allowed.has(currentStatus)) {
            throw new BadRequestException('当前订单状态不支持申请售后');
        }
        if (currentStatus === 'REFUNDED') {
            throw new BadRequestException('已退款订单不可重复申请售后');
        }

        const paymentChannel = String(order?.latestPayment?.channel || '').trim().toUpperCase();
        const refundSupported = this.isComplaintRefundSupportedChannel(paymentChannel);
        const refundUnsupportedReason = this.getComplaintRefundUnsupportedReason(paymentChannel);
        const paidAmount = this.toAmount2(Number(order?.latestPayment?.amount ?? order?.paidAmount ?? order?.finalPayableAmount ?? order?.receivableAmount ?? 0));
        const suggestedRefundAmount = this.getComplaintSuggestedRefundAmount(paidAmount);

        const complaint = await this.prisma.$transaction(async (tx) => {
            const exists = await this.findComplaintWorkOrderByOrderId(tx, orderId);
            if (exists && ['PENDING_REVIEW', 'APPROVED', 'REFUNDED'].includes(String(exists.status || ''))) {
                throw new BadRequestException('该订单已有处理中或已完成的客诉工单');
            }

            await tx.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.WAIT_AFTERSALE },
            });

            if (exists) {
                return this.updateComplaintWorkOrderTx(tx, exists.id, {
                    status: 'PENDING_REVIEW',
                    reason,
                    description,
                    paymentChannel,
                    refundSupported,
                    refundUnsupportedReason,
                    suggestedRefundAmount,
                    approvedRefundAmount: null,
                    reviewRemark: null,
                    refundRemark: null,
                    reviewedBy: null,
                    reviewedAt: null,
                    refundedBy: null,
                    refundedAt: null,
                });
            }

            return this.createComplaintWorkOrderTx(tx, {
                orderId,
                userId,
                status: 'PENDING_REVIEW',
                reason,
                description,
                paymentChannel,
                refundSupported,
                refundUnsupportedReason,
                suggestedRefundAmount,
            });
        });

        return {
            success: true,
            status: OrderStatus.WAIT_AFTERSALE,
            manualRefundRequired: !refundSupported,
            refundHint: refundUnsupportedReason,
            complaint: this.buildComplaintWorkOrderView(complaint, order),
        };
    }

    async listComplaintWorkOrders(query: { page?: number; limit?: number; status?: string; keyword?: string }) {
        const page = Math.max(1, Number(query?.page || 1));
        const limit = Math.min(100, Math.max(1, Number(query?.limit || 20)));
        const offset = (page - 1) * limit;
        const status = String(query?.status || '').trim().toUpperCase();
        const keyword = String(query?.keyword || '').trim();
        const where: string[] = ['1=1'];
        const params: any[] = [];
        if (status) {
            where.push('status = ?');
            params.push(status);
        }
        if (keyword) {
            where.push('(ticketNo LIKE ? OR reason LIKE ? OR description LIKE ?)');
            params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
        }
        const whereSql = where.join(' AND ');
        const rows = await this.prisma.$queryRawUnsafe(
            `SELECT * FROM complaint_work_orders WHERE ${whereSql} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
            ...params,
            limit,
            offset,
        );
        const totalRows = await this.prisma.$queryRawUnsafe(
            `SELECT COUNT(*) AS total FROM complaint_work_orders WHERE ${whereSql}`,
            ...params,
        );
        const normalized = ((rows as any[]) || []).map((item) => this.normalizeComplaintWorkOrderRow(item)).filter(Boolean);
        const orderMap = await this.getComplaintOrderMap(normalized.map((item: any) => Number(item.orderId)));
        return {
            data: normalized.map((item: any) => this.buildComplaintWorkOrderView(item, orderMap.get(Number(item.orderId)))),
            total: Number((totalRows as any[])?.[0]?.total || 0),
            page,
            limit,
            totalPages: Math.ceil(Number((totalRows as any[])?.[0]?.total || 0) / limit),
        };
    }

    async reviewComplaintWorkOrder(id: number, operatorId: number, body: { action?: string; reviewRemark?: string; approvedRefundAmount?: number }) {
        id = Number(id);
        operatorId = Number(operatorId);
        if (!id) throw new BadRequestException('id 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');
        const ticket = await this.findComplaintWorkOrderById(this.prisma, id);
        if (!ticket) throw new NotFoundException('客诉工单不存在');
        if (String(ticket.status || '') === 'REFUNDED') throw new BadRequestException('该工单已完成退款');
        const action = String(body?.action || '').trim().toUpperCase();
        const reviewRemark = body?.reviewRemark ? String(body.reviewRemark).trim().slice(0, 255) : null;
        if (!['APPROVE', 'REJECT'].includes(action)) throw new BadRequestException('审核动作不合法');

        const next = await this.prisma.$transaction(async (tx) => {
            if (action === 'REJECT') {
                await tx.order.update({ where: { id: Number(ticket.orderId) }, data: { status: OrderStatus.AFTERSALE_DONE } });
                return this.updateComplaintWorkOrderTx(tx, id, {
                    status: 'REJECTED',
                    reviewRemark,
                    reviewedBy: operatorId,
                    reviewedAt: new Date(),
                });
            }
            return this.updateComplaintWorkOrderTx(tx, id, {
                status: 'APPROVED',
                reviewRemark,
                approvedRefundAmount:
                    body?.approvedRefundAmount === undefined || body?.approvedRefundAmount === null
                        ? ticket.approvedRefundAmount ?? ticket.suggestedRefundAmount
                        : this.toAmount2(Number(body.approvedRefundAmount)),
                reviewedBy: operatorId,
                reviewedAt: new Date(),
            });
        });
        const orderMap = await this.getComplaintOrderMap([Number(ticket.orderId)]);
        const complaintOrder = orderMap.get(Number(ticket.orderId));
        try {
            await this.miniSubscribeMessageService.pushAfterSalesResultMessage({
                userId: Number(ticket.userId),
                orderId: Number(ticket.orderId),
                orderNo: String(complaintOrder?.autoSerial || `#${ticket.orderId}`),
                result: action === 'REJECT' ? '售后申请已驳回' : '售后申请已审核通过',
                refundAmount: action === 'REJECT' ? undefined : Number(next?.approvedRefundAmount ?? ticket.suggestedRefundAmount ?? 0),
                reviewedAt: next?.reviewedAt || new Date(),
                remark: reviewRemark || (action === 'REJECT' ? '请查看审核意见' : '请留意后续退款处理'),
            });
        } catch (e: any) {
            console.error('[notify][mini-after-sales][review] failed', e?.message || e);
        }
        return this.buildComplaintWorkOrderView(next, orderMap.get(Number(ticket.orderId)));
    }

    async refundComplaintWorkOrder(id: number, operatorId: number, body: { refundAmount?: number; refundRemark?: string }) {
        id = Number(id);
        operatorId = Number(operatorId);
        if (!id) throw new BadRequestException('id 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');
        const ticket = await this.findComplaintWorkOrderById(this.prisma, id);
        if (!ticket) throw new NotFoundException('客诉工单不存在');
        if (!ticket.refundSupported) throw new BadRequestException(ticket.refundUnsupportedReason || '当前支付渠道不支持原路退款');
        if (!['APPROVED', 'PENDING_REVIEW'].includes(String(ticket.status || ''))) {
            throw new BadRequestException('仅审核通过的工单可执行退款');
        }

        const amount = body?.refundAmount === undefined || body?.refundAmount === null
            ? this.toAmount2(Number(ticket.approvedRefundAmount ?? ticket.suggestedRefundAmount ?? 0))
            : this.toAmount2(Number(body.refundAmount));
        if (!(amount > 0)) throw new BadRequestException('退款金额必须大于 0');

        const refundRemark = body?.refundRemark ? String(body.refundRemark).trim().slice(0, 255) : null;
        await this.refundOrder(Number(ticket.orderId), operatorId, refundRemark || '客诉工单退款', {
            refundAmount: amount,
            strictOriginalReturn: true,
        });

        const next = await this.prisma.$transaction(async (tx) => {
            return this.updateComplaintWorkOrderTx(tx, id, {
                status: 'REFUNDED',
                approvedRefundAmount: amount,
                refundRemark,
                refundedBy: operatorId,
                refundedAt: new Date(),
                reviewedBy: ticket.reviewedBy ?? operatorId,
                reviewedAt: ticket.reviewedAt ?? new Date(),
            });
        });
        const orderMap = await this.getComplaintOrderMap([Number(ticket.orderId)]);
        const complaintOrder = orderMap.get(Number(ticket.orderId));
        try {
            await this.miniSubscribeMessageService.pushAfterSalesResultMessage({
                userId: Number(ticket.userId),
                orderId: Number(ticket.orderId),
                orderNo: String(complaintOrder?.autoSerial || `#${ticket.orderId}`),
                result: '退款已完成',
                refundAmount: amount,
                reviewedAt: next?.refundedAt || new Date(),
                remark: refundRemark || '退款已原路退回，请留意到账情况',
            });
        } catch (e: any) {
            console.error('[notify][mini-after-sales][refund] failed', e?.message || e);
        }
        return this.buildComplaintWorkOrderView(next, orderMap.get(Number(ticket.orderId)));
    }

    /*** -----------------------------
     * 退款功能
     * todo 1-24需确认是否将所有生成流水都处理退款。无论什么状态
     * -----------------------------*/
    async refundOrder(
        orderId: number,
        operatorId: number,
        remark?: string,
        options?: {
            staffLiable?: boolean;
            liableUserIds?: number[];
            hasCompensation?: boolean;
            compensationAmount?: number;
            refundAmount?: number;
            strictOriginalReturn?: boolean;
        },
    ) {
        orderId = Number(orderId);
        operatorId = Number(operatorId);
        if (!orderId) throw new BadRequestException('orderId 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');
        const staffLiable = Boolean(options?.staffLiable);
        const hasCompensation = Boolean(options?.hasCompensation);

        const order: any = await this.prisma.order.findUnique({
            where: {id: orderId},
            include: {
                dispatches: {
                    select: {
                        id: true,
                        status: true,
                        participants: {
                            select: {
                                userId: true,
                                acceptedAt: true,
                                rejectedAt: true,
                            },
                        },
                    },
                },
                settlements: {select: {id: true, userId: true, paymentStatus: true, calculatedEarnings: true, finalEarnings: true}},
                latestPayment: { select: { id: true, channel: true, status: true, amount: true, transactionId: true, paymentNo: true } },
            },
        });
        if (!order) throw new NotFoundException('订单不存在');

        if (order.status === OrderStatus.REFUNDED) {
            throw new BadRequestException('订单已退款，禁止重复退款');
        }

        const orderWithPayment = await this.ensureLegacySuccessfulPaymentForRefund(order);
        const latestPaymentChannel = String((orderWithPayment as any)?.latestPayment?.channel || '').trim().toUpperCase();
        const latestPaymentStatus = String((orderWithPayment as any)?.latestPayment?.status || '').trim().toUpperCase();
        if (latestPaymentStatus !== OrderPayStatus.SUCCESS) {
            throw new BadRequestException('订单未支付完成，无法退款');
        }

        const shouldAutoRefund = this.shouldAutoRefundWithWechat(orderWithPayment as any);
        const shouldRefundBalance = latestPaymentChannel === 'BALANCE';
        const manualRefundRequired = !shouldAutoRefund && !shouldRefundBalance;
        if (Boolean(options?.strictOriginalReturn) && manualRefundRequired) {
            throw new BadRequestException(this.getComplaintRefundUnsupportedReason(latestPaymentChannel) || '当前支付渠道不支持原路退款');
        }

        const latestPaymentAmountFen = this.toAmountFen(
            Number(
                (orderWithPayment as any)?.latestPayment?.amount ??
                order.paidAmount ??
                order.receivableAmount ??
                order.finalPayableAmount ??
                0,
            ),
        );
        if ((shouldAutoRefund || shouldRefundBalance) && latestPaymentAmountFen <= 0) {
            throw new BadRequestException('订单支付金额异常，无法发起退款');
        }
        const requestedRefundAmount =
            options?.refundAmount === undefined || options?.refundAmount === null
                ? null
                : this.toAmount2(Number(options.refundAmount));
        if (requestedRefundAmount !== null && !(requestedRefundAmount > 0)) {
            throw new BadRequestException('退款金额必须大于 0');
        }
        if (requestedRefundAmount !== null && requestedRefundAmount > this.toAmount2(Number(latestPaymentAmountFen / 100))) {
            throw new BadRequestException('退款金额不能超过订单实付金额');
        }
        const refundAmountFen = requestedRefundAmount === null ? latestPaymentAmountFen : this.toAmountFen(requestedRefundAmount);
        const refundAmount = this.toAmount2(Number(refundAmountFen / 100));
        const refundReason = remark ? String(remark).trim().slice(0, 80) : '订单退款';
        const refundNo = this.buildRefundNo(latestPaymentChannel, orderId);

        const autoRefundTrace = shouldAutoRefund
            ? await this.wechatPayService.refundTransaction({
                  outTradeNo: String((orderWithPayment as any)?.latestPayment?.paymentNo || '').trim(),
                  transactionId: String((orderWithPayment as any)?.latestPayment?.transactionId || '').trim() || undefined,
                  outRefundNo: refundNo,
                  amountFen: refundAmountFen,
                  totalFen: latestPaymentAmountFen,
                  reason: refundReason,
              })
            : null;

        const settlementUserIds: number[] = Array.from(
            new Set(
                (order.settlements || [])
                    .map((x) => Number((x as any).userId))
                    .filter((n) => Number.isFinite(n) && n > 0),
            ),
        );
        const participantUserIds: number[] = Array.from(
            new Set(
                (order.dispatches || [])
                    .flatMap((d: any) => d?.participants || [])
                    // 退款有责处罚：以“本单参与且未拒单”为准，不依赖 acceptedAt，
                    // 避免在“等待客服确认结单”阶段因历史数据 acceptedAt 为空被误过滤
                    .filter((p: any) => !p?.rejectedAt)
                    .map((p: any) => Number(p?.userId))
                    .filter((n: number) => Number.isFinite(n) && n > 0),
            ),
        );
        const defaultLiableUserIds = settlementUserIds.length ? settlementUserIds : participantUserIds;
        const customLiableUserIds: number[] = Array.isArray(options?.liableUserIds)
            ? Array.from(
                new Set(
                    options.liableUserIds
                        .map((x) => Number(x))
                        .filter((n) => Number.isFinite(n) && n > 0),
                ),
            )
            : [];

        const liableUserIds = customLiableUserIds.length
            ? customLiableUserIds.filter((id) => defaultLiableUserIds.includes(id))
            : defaultLiableUserIds;

        if (staffLiable && liableUserIds.length === 0) {
            throw new BadRequestException('当前订单未找到可处罚打手，请指定 liableUserIds 或检查结算参与人');
        }

        if (staffLiable && customLiableUserIds.length > 0 && liableUserIds.length !== customLiableUserIds.length) {
            throw new BadRequestException('liableUserIds 存在非本订单参与打手');
        }

        const compensationAmount = hasCompensation ? this.toAmount2(Number(options?.compensationAmount || 0)) : 0;
        if (hasCompensation && compensationAmount <= 0) {
            throw new BadRequestException('勾选赔付时，赔付金额必须大于0');
        }
        if (hasCompensation && defaultLiableUserIds.length === 0) {
            throw new BadRequestException('当前订单未找到可分摊赔付的打手');
        }

        const orderAmountBase = this.toAmount2(
            Math.max(
                Number(order.paidAmount || 0),
                Number(order.receivableAmount || 0),
                Number((order as any).finalPayableAmount || 0),
            ),
        );
        const liabilityPenaltyPerUser = this.toAmount2(Math.max(20, orderAmountBase * 0.1));
        const compensationAllocations = hasCompensation
            ? this.splitSharedAmountByUsers(compensationAmount, defaultLiableUserIds)
            : [];
        if (hasCompensation && compensationAllocations.length === 0) {
            throw new BadRequestException('赔付分摊失败，请检查本单打手信息');
        }

        const now = new Date();
        let liabilityPenaltyResult: any = null;
        let compensationPenaltyResult: any = null;
        const penaltyWarnings: string[] = [];

        await this.prisma.$transaction(async (tx) => {
            await tx.orderRefund.create({
                data: {
                    orderId,
                    paymentId: Number((orderWithPayment as any)?.latestPayment?.id || 0) || null,
                    refundNo,
                    channel: latestPaymentChannel || this.resolvePaymentChannelByOrderSource((orderWithPayment as any)?.orderSource),
                    status: manualRefundRequired ? 'MANUAL_REQUIRED' : 'SUCCESS',
                    amount: refundAmount,
                    currency: 'CNY',
                    reason: refundReason,
                    externalRefundId: String(autoRefundTrace?.refundId || '').trim() || null,
                    operatorId,
                    raw: autoRefundTrace ? (autoRefundTrace as any) : null,
                    refundedAt: now,
                },
            });

            if (shouldRefundBalance) {
                const customerUserId = Number((order as any)?.customerUserId || 0);
                if (!customerUserId) {
                    throw new BadRequestException('订单缺少付款用户，无法退款');
                }
                await this.wallet.creditAvailableBalance(
                    {
                        userId: customerUserId,
                        amount: refundAmount,
                        bizType: WalletBizType.REFUND_REVERSAL,
                        sourceType: 'ORDER_REFUND',
                        sourceId: orderId,
                    },
                    tx as any,
                );
            }

            // 1) 订单状态置 REFUNDED（要“结单状态并标记退款”：这里用 REFUNDED 即“已结单且已退款”）
            await tx.order.update({
                where: {id: orderId},
                data: {status: OrderStatus.REFUNDED},
            });

            // 2) 当前/历史 dispatch 如果不是终态，可选标记为 COMPLETED（防止继续流转）
            //    这里按“退款即结束”处理：把非 COMPLETED 的 ACCEPTED/WAIT_ACCEPT/WAIT_ASSIGN/ARCHIVED 统一改为 COMPLETED
            await tx.orderDispatch.updateMany({
                where: {
                    orderId,
                    status: {in: [DispatchStatus.WAIT_ASSIGN, DispatchStatus.WAIT_ACCEPT, DispatchStatus.ACCEPTED, DispatchStatus.ARCHIVED]},
                },
                data: {
                    status: DispatchStatus.COMPLETED,
                    completedAt: now,
                    remark: remark ? `REFUND:${remark}` : 'REFUND',
                },
            });

            // 2.1) 退款后刷新本单相关参与者工作状态，避免“已接单但退款后仍卡 WORKING”
            const refundParticipantUserIds = Array.from(
                new Set(
                    [
                        ...((order.dispatches || []).flatMap((d: any) => d?.participants || []) as any[]),
                        ...((order.settlements || []).map((s: any) => ({userId: s?.userId})) as any[]),
                    ]
                        .map((p: any) => Number(p?.userId || 0))
                        .filter((n: number) => Number.isFinite(n) && n > 0),
                ),
            );
            if (refundParticipantUserIds.length > 0) {
                await this.refreshPlayerWorkStatusByActiveAcceptedDispatches(tx, refundParticipantUserIds);
            }

            // 3) 若已经结单产生 settlements：清零陪玩收益（finalEarnings=0，manualAdjustment = -calculatedEarnings）
            //    这样“清零”且保留 calculatedEarnings 便于追溯
            if (order.settlements && order.settlements.length > 0) {
                for (const s of order.settlements) {
                    await tx.orderSettlement.update({
                        where: {id: s.id},
                        data: {
                            finalEarnings: 0,
                            manualAdjustment: 0 - Number(s.calculatedEarnings ?? 0),
                            adjustedBy: operatorId,
                            adjustedAt: now,
                            adjustRemark: remark ? `REFUND_CLEAR:${remark}` : 'REFUND_CLEAR',
                        },
                    });
                }
            }

            // 同步汇总
            await tx.order.update({
                where: {id: orderId},
                data: {
                    totalPlayerEarnings: 0,
                },
            });

            // ✅ 4) 钱包冲正：无论是否已有 settlements，只要订单曾产生收益流水都要回滚
            await this.wallet.reverseOrderSettlementEarnings({orderId}, tx);

            // ✅ 4.1) 续单分红全额冲正 / 待结算续单置无效
            await this.reverseRenewalBonusesTx({
                tx,
                orderId,
                operatorId,
                reason: remark ? `ORDER_REFUNDED:${remark}` : 'ORDER_REFUNDED',
                groupStatusAfter: 'REVERSED',
            });

            // ✅ 5) 退款回滚会员成长值与订单奖励积分
            await this.rollbackOrderMemberBenefitsTx(tx, orderWithPayment, refundAmount);
        });

        // 5) 退款后处罚（不阻断退款主流程）
        if (staffLiable && liableUserIds.length > 0) {
            try {
                liabilityPenaltyResult = await this.penaltiesService.createRefundLiabilityPenaltyBatch({
                    orderId,
                    orderAutoSerial: String((order as any).autoSerial || `#${orderId}`),
                    liableUserIds,
                    amountPerUser: liabilityPenaltyPerUser,
                    operatorId,
                    reason: remark,
                    allowInsufficientBalance: true,
                });
            } catch (e: any) {
                penaltyWarnings.push(`有责处罚执行失败：${e?.message || 'unknown error'}`);
            }
        }

        if (hasCompensation && compensationAllocations.length > 0) {
            try {
                compensationPenaltyResult = await this.penaltiesService.createRefundCompensationPenaltyBatch({
                    orderId,
                    orderAutoSerial: String((order as any).autoSerial || `#${orderId}`),
                    allocations: compensationAllocations,
                    operatorId,
                    reason: remark,
                    allowInsufficientBalance: true,
                });
            } catch (e: any) {
                penaltyWarnings.push(`赔付分摊扣款执行失败：${e?.message || 'unknown error'}`);
            }
        }

        await this.logOrderAction(operatorId, orderId, 'REFUND_ORDER', {
            remark: remark ?? null,
            autoRefundTriggered: shouldAutoRefund,
            manualRefundRequired,
            refundNo,
            refundChannel: latestPaymentChannel || null,
            autoRefundResult: autoRefundTrace
                ? {
                      refundId: autoRefundTrace.refundId,
                      status: autoRefundTrace.status,
                  }
                : null,
            clearedSettlements: (order.settlements?.length ?? 0) > 0,
            clearedCount: order.settlements?.length ?? 0,
            staffLiable,
            liabilityPenaltyPerUser: staffLiable ? liabilityPenaltyPerUser : 0,
            liabilityPenaltyUserIds: staffLiable ? liableUserIds : [],
            liabilityPenaltyCount: Number(liabilityPenaltyResult?.count || 0),
            liabilityPenaltyTicketIds: Array.isArray(liabilityPenaltyResult?.ticketIds)
                ? liabilityPenaltyResult.ticketIds
                : [],
            liabilityPendingCount: Number(liabilityPenaltyResult?.pendingCount || 0),
            hasCompensation,
            compensationAmount: hasCompensation ? compensationAmount : 0,
            compensationAllocations: hasCompensation ? compensationAllocations : [],
            compensationPenaltyCount: Number(compensationPenaltyResult?.count || 0),
            compensationPenaltyTicketIds: Array.isArray(compensationPenaltyResult?.ticketIds)
                ? compensationPenaltyResult.ticketIds
                : [],
            compensationPendingCount: Number(compensationPenaltyResult?.pendingCount || 0),
            penaltyWarnings,
        });

        try {
            const pointAccount = await this.prisma.memberPointAccount.findUnique({
                where: { userId: Number((order as any)?.customerUserId || 0) },
                select: { availablePoints: true },
            });
            const profile = await this.prisma.memberProfile.findUnique({
                where: { userId: Number((order as any)?.customerUserId || 0) },
                select: { annualContribution: true },
            });
            const benefitRollbackAmount = round2(Math.min(
                this.resolveMemberBenefitBaseAmount(order),
                Number(refundAmount || 0) >= Number((order as any)?.paidAmount || 0)
                    ? this.resolveMemberBenefitBaseAmount(order)
                    : Number(refundAmount || 0),
            ));
            const points = this.getOrderRewardPointsByPaidAmount(benefitRollbackAmount);
            const growthValue = this.getMemberGrowthValueByPaidAmount(benefitRollbackAmount);
            if (Number((order as any)?.customerUserId || 0) > 0) {
                await this.miniSubscribeMessageService.pushMemberAssetMessage({
                    userId: Number((order as any).customerUserId),
                    assetType: '退款回退资产',
                    changeAmount: `积分-${points} / 成长值-${growthValue}`,
                    balanceAfter: `积分余额 ${Number(pointAccount?.availablePoints || 0)} / 成长值 ${Number(profile?.annualContribution || 0)}`,
                    targetType: 'ORDER',
                    targetId: Number(orderId),
                    pageQuery: { id: Number(orderId) },
                    remark: `订单退款 ¥${Number(refundAmount || 0).toFixed(2)}，对应会员资产已回退`,
                });
            }
        } catch (e: any) {
            console.error('[notify][mini-member-asset][refund-order] failed', e?.message || e);
        }

        return this.getOrderDetail(orderId);
    }

    async adminAcceptDispatch(dispatchId: number, operator: any, remark?: string) {
        const operatorId = Number(operator?.userId || 0);
        if (!dispatchId || !operatorId) throw new BadRequestException('参数非法');
        const requiredRemark = this.normalizeRequiredRemark(remark, '客服代接单请填写处理原因');

        return this.prisma.$transaction(async (tx) => {
            const dispatch = await tx.orderDispatch.findUnique({
                where: { id: dispatchId },
                include: {
                    order: true,
                    participants: true,
                },
            });
            if (!dispatch) throw new NotFoundException('派单批次不存在');
            if (Number(dispatch.order.currentDispatchId || 0) !== Number(dispatch.id)) {
                throw new BadRequestException('当前派单已更新，请刷新后再操作');
            }
            this.ensureDispatchStatus(dispatch, [DispatchStatus.WAIT_ACCEPT, DispatchStatus.ACCEPTED], '当前状态不可代接单');

            const activeParticipants = (dispatch.participants || []).filter((p: any) => p?.isActive !== false && !p?.rejectedAt);
            if (!activeParticipants.length) {
                throw new BadRequestException('当前派单没有可代接单的有效参与者');
            }

            const now = new Date();
            await tx.orderParticipant.updateMany({
                where: {
                    dispatchId,
                    id: { in: activeParticipants.map((p: any) => Number(p.id)) },
                    acceptedAt: null,
                },
                data: {
                    acceptedAt: now,
                },
            });

            await tx.user.updateMany({
                where: {
                    id: { in: activeParticipants.map((p: any) => Number(p.userId)) },
                },
                data: {
                    workStatus: 'WORKING' as any,
                    staffDormantFreezeBaseAt: null,
                },
            });

            await tx.orderDispatch.update({
                where: { id: dispatchId },
                data: {
                    status: DispatchStatus.ACCEPTED,
                    acceptedAllAt: dispatch.acceptedAllAt || now,
                },
            });

            await tx.order.update({
                where: { id: dispatch.orderId },
                data: { status: OrderStatus.ACCEPTED },
            });

            await this.logOrderAction(operatorId, dispatch.orderId, 'ADMIN_ACCEPT_DISPATCH', {
                dispatchId,
                acceptedAt: now.toISOString(),
                participantUserIds: activeParticipants.map((p: any) => Number(p.userId)),
                remark: requiredRemark,
            }, tx, '客服代接单');

            return this.getDispatchWithParticipants(dispatchId);
        });
    }

    async adminArchiveDispatch(dispatchStatus: DispatchStatus, dispatchId: number, operator: any, dto: any) {
        return this.archiveDispatchWithOptions(dispatchStatus, dispatchId, operator, dto, { forceByAdmin: true });
    }

    async rollbackDispatchToAccepted(dispatchId: number, operator: any, remark?: string) {
        const operatorId = Number(operator?.userId || 0);
        if (!dispatchId || !operatorId) throw new BadRequestException('参数非法');
        const requiredRemark = this.normalizeRequiredRemark(remark, '客服回退到接单中请填写处理原因');

        const orderId = await this.prisma.$transaction(async (tx) => {
            const dispatch = await tx.orderDispatch.findUnique({
                where: { id: dispatchId },
                include: {
                    order: true,
                    participants: true,
                },
            });
            if (!dispatch) throw new NotFoundException('派单批次不存在');
            if (dispatch.status !== DispatchStatus.ARCHIVED) {
                throw new BadRequestException('仅存单状态支持回退到接单中');
            }
            if (Number(dispatch.order.currentDispatchId || 0) !== Number(dispatch.id)) {
                throw new BadRequestException('该轮已不是当前轮，不支持回退');
            }
            const settlementCount = await tx.orderSettlement.count({ where: { dispatchId } });
            if (settlementCount > 0) {
                throw new BadRequestException('该轮已生成结算数据，不支持回退');
            }

            const participantIds = (dispatch.participants || [])
                .filter((p: any) => !p?.rejectedAt)
                .map((p: any) => Number(p.id));
            const participantUserIds = (dispatch.participants || [])
                .filter((p: any) => !p?.rejectedAt)
                .map((p: any) => Number(p.userId));

            if (!participantIds.length) {
                throw new BadRequestException('当前轮没有可恢复的参与者');
            }

            await tx.orderParticipant.updateMany({
                where: { id: { in: participantIds } },
                data: { isActive: true },
            });
            await tx.orderDispatch.update({
                where: { id: dispatchId },
                data: {
                    status: DispatchStatus.ACCEPTED,
                    archivedAt: null,
                    completedAt: null,
                },
            });
            await tx.order.update({
                where: { id: dispatch.orderId },
                data: { status: OrderStatus.ACCEPTED },
            });
            await tx.user.updateMany({
                where: { id: { in: participantUserIds } },
                data: { workStatus: 'WORKING' as any },
            });

            await this.logOrderAction(operatorId, dispatch.orderId, 'ADMIN_ROLLBACK_DISPATCH_TO_ACCEPTED', {
                dispatchId,
                fromStatus: DispatchStatus.ARCHIVED,
                toStatus: DispatchStatus.ACCEPTED,
                remark: requiredRemark,
            }, tx, '客服回退存单到接单中');

            return dispatch.orderId;
        });

        return this.getOrderDetail(orderId);
    }

    async rollbackCompletedDispatchToArchived(dispatchId: number, operator: any, remark?: string) {
        const operatorId = Number(operator?.userId || 0);
        if (!dispatchId || !operatorId) throw new BadRequestException('参数非法');
        const requiredRemark = this.normalizeRequiredRemark(remark, '客服回退到存单请填写处理原因');

        const orderId = await this.prisma.$transaction(async (tx) => {
            const dispatch = await tx.orderDispatch.findUnique({
                where: { id: dispatchId },
                include: {
                    order: true,
                },
            });
            if (!dispatch) throw new NotFoundException('派单批次不存在');
            if (dispatch.status !== DispatchStatus.COMPLETED) {
                throw new BadRequestException('仅结单状态支持回退到存单');
            }
            if (dispatch.order.status !== OrderStatus.COMPLETED_PENDING_CONFIRM) {
                throw new BadRequestException('仅待确认结单阶段支持回退');
            }
            if (Number(dispatch.order.currentDispatchId || 0) !== Number(dispatch.id)) {
                throw new BadRequestException('该轮已不是当前轮，不支持回退');
            }
            const settlementCount = await tx.orderSettlement.count({ where: { dispatchId } });
            if (settlementCount > 0) {
                throw new BadRequestException('该轮已生成结算数据，不支持回退');
            }

            await tx.orderDispatch.update({
                where: { id: dispatchId },
                data: {
                    status: DispatchStatus.ARCHIVED,
                    completedAt: null,
                },
            });
            await tx.order.update({
                where: { id: dispatch.orderId },
                data: { status: OrderStatus.ARCHIVED },
            });

            await this.logOrderAction(operatorId, dispatch.orderId, 'ADMIN_ROLLBACK_DISPATCH_TO_ARCHIVED', {
                dispatchId,
                fromStatus: DispatchStatus.COMPLETED,
                toStatus: DispatchStatus.ARCHIVED,
                remark: requiredRemark,
            }, tx, '客服回退误结单到存单');

            return dispatch.orderId;
        });

        return this.getOrderDetail(orderId);
    }

    /*** -----------------------------
     * 订单编辑
     * -----------------------------*/
    async updateOrderEditable(dto: any, operatorId: number) {
        operatorId = Number(operatorId);
        const orderId = Number(dto?.id);
        if (!orderId) throw new BadRequestException('id 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');

        const order = await this.prisma.order.findUnique({
            where: {id: orderId},
            include: {project: true},
        });
        if (!order) throw new NotFoundException('订单不存在');

        // 未结单才允许编辑
        const forbid = new Set<OrderStatus>([OrderStatus.COMPLETED, OrderStatus.REFUNDED]);
        if (forbid.has(order.status)) throw new BadRequestException('已结单/已退款订单不允许编辑');

        // 允许编辑的字段（不含陪玩/派单）
        const data: any = {
            orderQuantity: dto.orderQuantity != null ? Number(dto.orderQuantity) : undefined,
            receivableAmount: dto.receivableAmount != null ? Number(dto.receivableAmount) : undefined,
            paidAmount: dto.paidAmount != null ? Number(dto.paidAmount) : undefined,
            settlementBaseAmount: dto.settlementAmount != null
                ? Number(dto.settlementAmount)
                : (dto.settlementBaseAmount != null
                    ? Number(dto.settlementBaseAmount)
                    : (dto.paidAmount != null
                        ? Number(dto.paidAmount)
                        : (dto.receivableAmount != null ? Number(dto.receivableAmount) : undefined))),
            baseAmountWan: dto.baseAmountWan != null ? Number(dto.baseAmountWan) : undefined,
            customerGameId: dto.customerGameId ?? undefined,
            orderTime: dto.orderTime ? new Date(dto.orderTime) : undefined,
            paymentTime: dto.paymentTime ? new Date(dto.paymentTime) : undefined,
            csRate: dto.csRate != null ? Number(dto.csRate) : undefined,
            inviteRate: dto.inviteRate != null ? Number(dto.inviteRate) : undefined,
            inviter: dto.inviter ?? undefined,
            customClubRate: dto.customClubRate != null ? Number(dto.customClubRate) : undefined,
        };

        // 项目变更：同步 projectSnapshot + clubRate（落库快照）
        if (dto.projectId && Number(dto.projectId) !== order.projectId) {
            const project = await this.prisma.gameProject.findUnique({where: {id: Number(dto.projectId)}});
            if (!project) throw new NotFoundException('项目不存在');

            data.projectId = project.id;

            data.projectSnapshot = {
                id: project.id,
                name: project.name,
                type: project.type,
                billingMode: project.billingMode,
                price: project.price,
                baseAmount: project.baseAmount ?? null,
                clubRate: project.clubRate ?? null,
                coverImage: project.coverImage ?? null,
            } as any;

            // 注意：clubRate 是“订单级固定抽成快照”，仍遵循优先级：customClubRate > 项目 clubRate
            data.clubRate = (dto.customClubRate != null ? Number(dto.customClubRate) : (project.clubRate ?? null));
        }

        const updated = await this.prisma.order.update({
            where: {id: orderId},
            data,
        });

        await this.logOrderAction(operatorId, orderId, 'UPDATE_ORDER', {
            changes: data,
            remark: dto.remark ?? null,
        });

        return this.getOrderDetail(orderId);
    }

    /*** -----------------------------
     * 确认收款（管理端/财务）
     * - 这是财务动作，不属于“订单编辑”
     * - 允许在已结单后执行（先打后付的典型场景）
     * - 允许修正最终实收金额（paidAmount）
     * - 强制覆盖 paymentTime 为当前时间，并将 isPaid 标记为 true
     * -----------------------------*/
    async markOrderPaid(dto: MarkPaidDto, operatorId: number) {
        operatorId = Number(operatorId);
        const orderId = Number((dto as any)?.id);
        const paidAmount = Number((dto as any)?.paidAmount);

        if (!operatorId) throw new BadRequestException('未登录或无权限操作');
        if (!orderId) throw new BadRequestException('id 必填');
        if (!Number.isFinite(paidAmount)) throw new BadRequestException('paidAmount 非法');

        // 只取本方法需要的字段，避免 include 太重
        const order = await this.prisma.order.findUnique({
            where: {id: orderId},
            select: {
                id: true,
                status: true,
                isGifted: true,
                isPaid: true,
                paidAmount: true,
                paymentTime: true,
                autoSerial: true,
                projectId: true,
            },
        });

        if (!order) throw new NotFoundException('订单不存在');

        // 赠送单不收款，避免误操作导致统计混乱
        if (order.isGifted) {
            throw new BadRequestException('赠送单不需要确认收款');
        }

        // 已退款订单不允许确认收款，避免状态冲突
        if (order.status === OrderStatus.REFUNDED) {
            throw new BadRequestException('已退款订单不允许确认收款');
        }

        // 防止重复确认
        if (order.isPaid) {
            throw new ConflictException('订单已确认收款，无需重复操作');
        }

        const now = new Date();

        const updated = await this.prisma.order.update({
            where: {id: orderId},
            data: {
                // 最终实收金额以本次确认为准（支持补差/改价）
                paidAmount,

                // 人工确认收款：写标记 + 写时间
                isPaid: true,
                paymentTime: now,
                payStatus: OrderPayStatus.SUCCESS,
            },
        });

        const manualPayment = await this.prisma.orderPayment.create({
            data: {
                orderId,
                paymentNo: `MAN-${orderId}-${Date.now()}`,
                channel: 'MANUAL_SHOUQIANBA',
                status: OrderPayStatus.SUCCESS,
                amount: paidAmount,
                currency: 'CNY',
                paidAt: now,
            },
            select: { id: true },
        });

        await this.prisma.order.update({
            where: { id: orderId },
            data: { latestPaymentId: manualPayment.id },
        });

        await this.logOrderAction(operatorId, orderId, 'MARK_PAID', {
            autoSerial: order.autoSerial,
            before: {
                isPaid: order.isPaid,
                paidAmount: order.paidAmount,
                paymentTime: order.paymentTime,
            },
            after: {
                isPaid: true,
                paidAmount,
                paymentTime: now,
            },
            remark: (dto as any)?.remark ?? null,
        });

        return this.getOrderDetail(orderId);
    }

    /**
     * ARCHIVED（存单）轮修复：按“本轮总保底进度(万)”均分到当前轮所有参与者，并触发“仅重算结算、不动钱包”
     * - 仅用于保底单（BillingMode.GUARANTEED / BASE）
     * - 允许负数（炸单修正）
     * - 不新增钱包流水：allowWalletSync=false
     * - 结算记录采取“覆盖”策略（先清理本轮结算，再按最新进度重建）
     */
    /**
     * ARCHIVED（存单）轮修复（不触发重算）：
     * - GUARANTEED/BASE：按“本轮总保底进度(万)”均分到本轮所有参与者（更新 OrderParticipant.progressBaseWan）
     * - HOURLY：修复本轮 billableHours（更新 OrderDispatch.billableHours），不涉及 OrderParticipant
     *
     * 共同约束：
     * - 仅允许 ARCHIVED
     * - 不触发结算重算（不 deleteMany，不 createSettlementsForDispatch，不动钱包）
     * - 允许负数（保底单：炸单修正）
     */
    async updateArchivedDispatchProgressTotal(
        dispatchId: number,
        totalProgressBaseWan: number,
        operatorId: number,
        remark?: string,
        // ✅ Controller 直接透传前端参数：最小扩展
        fixType?: 'GUARANTEED' | 'HOURLY',
        billableHours?: number,
    ) {
        dispatchId = Number(dispatchId);
        operatorId = Number(operatorId);

        const totalInt = Math.trunc(Number(totalProgressBaseWan));
        const hoursInt = Number(billableHours);

        if (!dispatchId) throw new BadRequestException('dispatchId 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');

        const splitEvenlyInt = (total: number, n: number) => {
            if (n <= 0) return [];
            const base = Math.trunc(total / n); // toward zero
            const rem = total - base * n; // could be negative
            const arr = new Array(n).fill(base);
            const k = Math.abs(rem);
            for (let i = 0; i < k; i++) {
                arr[i] += rem > 0 ? 1 : -1;
            }
            return arr;
        };

        return this.prisma.$transaction(async (tx) => {
            // 1) 读取 dispatch + order（事务内一致性）
            const dispatch = await tx.orderDispatch.findUnique({
                where: {id: dispatchId},
                include: {
                    order: {include: {project: true}},
                    participants: true,
                },
            });
            if (!dispatch) throw new NotFoundException('派单批次不存在');

            // 2) 仅允许 ARCHIVED
            if ((dispatch as any).status !== (DispatchStatus as any).ARCHIVED) {
                throw new BadRequestException('仅存单（ARCHIVED）轮允许修复');
            }

            // 3) 读取计费模式（以订单创建时快照/规则为准）
            const billingMode: BillingMode | undefined = this.getBillingModeFromOrder(dispatch.order as any);

            const GUARANTEED: any = (BillingMode as any).GUARANTEED ?? (BillingMode as any).BASE;
            const HOURLY: any = (BillingMode as any).HOURLY;

            // ✅ fixType 缺省：为了兼容旧前端/旧调用，默认按 GUARANTEED
            const fixTypeFinal: 'GUARANTEED' | 'HOURLY' = (fixType as any) || 'GUARANTEED';

            // =========================
            // A) HOURLY：只修 billableHours
            // =========================
            if (fixTypeFinal === 'HOURLY') {
                if (!HOURLY || billingMode !== HOURLY) {
                    throw new BadRequestException('仅小时单允许修复 billableHours');
                }
                if (!Number.isFinite(hoursInt)) throw new BadRequestException('billableHours 非法');

                const oldHours = Number((dispatch as any).billableHours ?? 0);

                await tx.orderDispatch.update({
                    where: {id: dispatchId},
                    data: {billableHours: hoursInt},
                });

                // 日志
                const parts = Array.isArray((dispatch as any).participants) ? (dispatch as any).participants : [];
                const participantCount = parts.filter((p: any) => Number(p?.userId) > 0).length;

                await this.writeUserLog(tx, {
                    userId: operatorId,
                    action: 'ARCHIVED_FIX_HOURS',
                    targetType: 'ORDER_DISPATCH',
                    targetId: dispatchId,
                    oldData: {
                        dispatchId,
                        billableHours: oldHours,
                        participantCount,
                    } as any,
                    newData: {
                        dispatchId,
                        billableHours: hoursInt,
                    } as any,
                    remark: remark || `ARCHIVED_FIX_HOURS=${hoursInt}（仅更新 billableHours，不触发重算）`,
                });

                return {orderId: dispatch.orderId, dispatchId, billableHours: hoursInt};
            }

            // =========================
            // B) GUARANTEED/BASE：均分 progressBaseWan（不重算）
            // =========================
            if (!GUARANTEED || billingMode !== GUARANTEED) {
                throw new BadRequestException('仅保底单允许修复保底进度');
            }
            if (!Number.isFinite(totalInt)) throw new BadRequestException('totalProgressBaseWan 非法');

            // 当前轮参与者：允许 isActive=false（存单后已归档），只要 userId 合法即可
            const parts = Array.isArray((dispatch as any).participants) ? (dispatch as any).participants : [];
            const activeParts = parts.filter((p: any) => Number(p?.userId) > 0);
            if (!activeParts.length) {
                throw new BadRequestException('该轮没有可修复的参与者');
            }

            // 均分
            const splits = splitEvenlyInt(totalInt, activeParts.length);

            // 更新参与者 progressBaseWan（逐条更新，保证每个人不同值）
            for (let i = 0; i < activeParts.length; i++) {
                const p = activeParts[i];
                await tx.orderParticipant.update({
                    where: {id: Number(p.id)},
                    data: {progressBaseWan: splits[i] ?? 0},
                });
            }

            // 日志（不再写 settlementBatchId，因为不重算）
            await this.writeUserLog(tx, {
                userId: operatorId,
                action: 'ARCHIVED_FIX_TOTAL_WAN',
                targetType: 'ORDER_DISPATCH',
                targetId: dispatchId,
                oldData: {
                    dispatchId,
                    totalProgressBaseWan: parts.reduce((s: number, p: any) => s + Number(p?.progressBaseWan ?? 0), 0),
                    participantCount: activeParts.length,
                } as any,
                newData: {
                    dispatchId,
                    totalProgressBaseWan: totalInt,
                    splits,
                } as any,
                remark: remark || `ARCHIVED_FIX_TOTAL_WAN=${totalInt}（均分到${activeParts.length}人；不触发重算）`,
            });

            return {orderId: dispatch.orderId, dispatchId, totalProgressBaseWan: totalInt, splits};
        });
    }


    
    
    /*** ===============客服确认结单结算和订单重算结算相关方法======================*/

    /**
     * 统一读取“结算/确认结单/重算修复”所需的订单数据
     *
     * 目的：
     * 1. 避免 confirmCompleteOrder / repairWalletForOrderSettlements 各自写一套 select
     * 2. 避免后续新增字段时一边改了另一边没改
     * 3. 作为所有 settlement 构建与重建财务/业绩的统一数据入口
     */
    private async loadOrderForSettlementTx(params: {
        tx: any;
        orderId: number;
        scope?: 'COMPLETED_AND_ARCHIVED' | 'COMPLETED_ONLY' | 'ARCHIVED_ONLY';
        includeAllDispatches?: boolean;
    }) {
        const {
            tx,
            orderId,
            scope = 'COMPLETED_AND_ARCHIVED',
            includeAllDispatches = false,
        } = params;

        const inStatuses =
            scope === 'COMPLETED_ONLY'
                ? [DispatchStatus.COMPLETED as any]
                : scope === 'ARCHIVED_ONLY'
                    ? [DispatchStatus.ARCHIVED as any]
                    : [DispatchStatus.COMPLETED as any, DispatchStatus.ARCHIVED as any];

        const dispatchWhere = includeAllDispatches ? undefined : { status: { in: inStatuses } };

        const order = await tx.order.findUnique({
            where: { id: Number(orderId) },
            select: {
                id: true,
                autoSerial: true,

                receivableAmount: true,
                paidAmount: true,
                settlementBaseAmount: true,
                isPaid: true,
                isGifted: true,
                giftedAmount: true,
                isTestPayment: true,

                orderQuantity: true,
                baseAmountWan: true,
                customClubRate: true,
                clubRate: true,

                projectId: true,
                projectSnapshot: true,
                project: {
                    select: {
                        id: true,
                        name: true,
                        type: true,
                        billingMode: true,
                        price: true,
                        clubRate: true,
                    },
                },

                dispatcherId: true,
                initialDispatcherId: true,
                dispatcher: {
                    select: {
                        id: true,
                        name: true,
                        userType: true,
                    },
                },
                initialDispatcher: {
                    select: {
                        id: true,
                        name: true,
                        userType: true,
                    },
                },

                status: true,
                createdAt: true,
                updatedAt: true,
                paymentTime: true,

                // ⚠️ 如果你当前 Order 还没有 customerUserId，就删掉这行
                // customerUserId: true,

                dispatches: {
                    ...(dispatchWhere ? { where: dispatchWhere } : {}),
                    select: {
                        id: true,
                        round: true,
                        status: true,
                        assignedAt: true,
                        acceptedAllAt: true,
                        archivedAt: true,
                        completedAt: true,
                        deductMinutes: true,
                        deductMinutesValue: true,
                        billableMinutes: true,
                        billableHours: true,
                        remark: true,
                        participants: {
                            select: {
                                id: true,
                                userId: true,
                                acceptedAt: true,
                                rejectedAt: true,
                                rejectReason: true,
                                isActive: true,
                                contributionAmount: true,
                                progressBaseWan: true,
                                user: {
                                    select: this.getDispatchParticipantUserSelect(),
                                },
                            },
                        },
                    },
                },

                settlements: {
                    where: { orderId: Number(orderId) },
                    orderBy: { id: 'asc' },
                    select: {
                        id: true,
                        orderId: true,
                        dispatchId: true,
                        userId: true,
                        settlementType: true,
                        settlementBatchId: true,
                        calculatedEarnings: true,
                        manualAdjustment: true,
                        finalEarnings: true,
                        paymentStatus: true,
                        settledAt: true,
                        user: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },

                playerEvaluations: {
                    orderBy: { id: 'asc' },
                    select: {
                        id: true,
                        orderId: true,
                        dispatchId: true,
                        playerUserId: true,
                        evaluatorId: true,
                        score: true,
                        ratingLabel: true,
                        afterSaleHandled: true,
                        afterSaleAction: true,
                        responsibleUserIds: true,
                        tippedUserIds: true,
                        tipPoolAmount: true,
                        tipAmount: true,
                        penaltyAmount: true,
                        maintenanceFeeAmount: true,
                        reviewRemark: true,
                        createdAt: true,
                        updatedAt: true,
                    },
                },
            },
        });

        if (!order) {
            throw new BadRequestException('订单不存在');
        }

        return order;
    }

    /**
     * 统一生成 settlement 计划
     *
     * 说明：
     * - 这里只“算”，不写库
     * - 由 billingMode 自动分发到对应 compute 方法
     * - 返回的是“标准化 settlement 计划”
     */
    private async buildSettlementPlanFromOrder(params: {
        order: any;
        modePlayAllocList?: any;
        playerEvaluations?: any[];
        autoConfirm?: boolean;
        orderTipEnabled?: boolean;
        orderTipUserIds?: any[];
        skipValidation?: boolean;
    }) {
        const { order, modePlayAllocList } = params;
        const skipValidation = Boolean(params.skipValidation);

        const billingMode = this.getBillingModeFromOrder(order);
        if (!billingMode) {
            throw new BadRequestException('订单缺少 billingMode');
        }

        const dispatches = [...(order.dispatches ?? [])].sort(
            (a, b) => (a.round ?? 0) - (b.round ?? 0),
        );

        if (!dispatches.length) {
            throw new BadRequestException('未找到可用于结算的派单轮次');
        }

        let settlementsToCreate: any[] = [];

        switch (billingMode) {
            case BillingMode.HOURLY:
                settlementsToCreate = await computeBillingHours(order as any);
                break;
            case BillingMode.GUARANTEED:
                settlementsToCreate = await computeBillingGuaranteed(order as any);
                break;
            case BillingMode.MODE_PLAY:
                settlementsToCreate = await computeBillingMODEPLAY(order as any, modePlayAllocList);
                break;
            default:
                throw new BadRequestException('未知 billingMode');
        }

        const applied = await this.applyPlayerEvaluationAdjustmentsToSettlements({
            order,
            settlementsToCreate,
            playerEvaluations: params.playerEvaluations ?? order?.playerEvaluations ?? [],
            autoConfirm: Boolean(params.autoConfirm),
            orderTipEnabled: params.orderTipEnabled,
            orderTipUserIds: params.orderTipUserIds,
            skipValidation,
        });
        settlementsToCreate = applied.settlementsToCreate;

        if (!Array.isArray(settlementsToCreate) || !settlementsToCreate.length) {
            throw new BadRequestException('未生成可写入的结算计划');
        }

        return {
            billingMode,
            settlementsToCreate,
            evaluationRows: applied.evaluationRows,
            tipPoolTotal: applied.tipPoolTotal,
            csPoolTotal: applied.csPoolTotal,
            validation: applied.validation,
        };
    }

    /**
     * 统一应用 settlement 计划
     *
     * mode:
     * - FINAL_CONFIRM：首次确认结单
     *   规则：要求当前订单不存在旧 settlement
     *
     * - REPAIR_REBUILD：重算修复
     *   规则：
     *   1. 冲正旧钱包
     *   2. 删除旧 settlement
     *   3. 重建新 settlement
     *   4. 写重算钱包流水
     *
     * 返回：
     * - 标准化 settlement 结果
     * - 供后续重建业绩 / 财务直接使用
     */
    private async applySettlementPlanTx(params: {
        tx: any;
        order: any;
        operatorId: number;
        settlementsToCreate: any[];
        mode: 'FINAL_CONFIRM' | 'REPAIR_REBUILD';
        reason?: string;
    }) {
        const { tx, order, operatorId, settlementsToCreate, mode, reason } = params;

        const orderId = Number(order.id);

        if (!settlementsToCreate?.length) {
            throw new BadRequestException('未找到可应用的 settlement 计划');
        }

        const settlementBatchId = randomUUID();

        /**
         * 将“计划 settlement”规范成可落库数据
         */
        const settlementCreateData = settlementsToCreate
            .filter((s: any) => {
                if (!s?.userId) return false;
                if (!s?.dispatchId) {
                    throw new BadRequestException(`settlement 缺 dispatchId：userId=${s.userId}`);
                }
                if (!s?.settlementType) {
                    throw new BadRequestException(`settlement 缺 settlementType：userId=${s.userId}`);
                }
                return true;
            })
            .map((s: any) => ({
                orderId,
                dispatchId: Number(s.dispatchId),
                userId: Number(s.userId),
                settlementType: String(s.settlementType),
                calculatedEarnings: s.calculatedEarnings,
                manualAdjustment: s.manualAdjustment ?? 0,
                finalEarnings: s.finalEarnings,
                clubEarnings: s.clubEarnings ?? 0,
                csEarnings: s.csEarnings ?? null,
                inviteEarnings: s.inviteEarnings ?? null,
                settlementBatchId,
                paymentStatus: 'UNPAID',
            }));

        if (!settlementCreateData.length) {
            throw new BadRequestException('settlementCreateData 为空，无法写入');
        }

        const settlementFreezeInfoByUser = await this.buildSettlementFreezeInfoByUserTx(
            tx,
            order,
            settlementCreateData.map((item: any) => Number(item.userId)),
        );
        const getSettlementFreezeInfo = (userId: number) => {
            const freezeInfo = settlementFreezeInfoByUser.get(Number(userId));
            if (freezeInfo) return freezeInfo;
            return computeSettlementFreezeTime({ order });
        };
        const buildFreezeInfoList = (rows: any[]) =>
            rows.map((row: any) => {
                const freezeInfo = getSettlementFreezeInfo(Number(row.userId));
                return {
                    userId: Number(row.userId),
                    freezeDays: freezeInfo.freezeDays,
                    freezeStartAt: freezeInfo.freezeStartAt,
                    freezeEndAt: freezeInfo.freezeEndAt,
                };
            });

        this.assertOrderSettlementPayoutWithinBase({
            order,
            settlements: settlementCreateData,
            context: mode === 'FINAL_CONFIRM' ? '客服确认结单' : '订单重算修复',
        });

        /**
         * 先做重复键校验，避免 createMany 后才炸
         */
        const keys = settlementCreateData.map(
            (s: any) => `${s.dispatchId}_${s.userId}_${s.settlementType}`,
        );
        const dupKeys = keys.filter((k: string, i: number) => keys.indexOf(k) !== i);
        if (dupKeys.length > 0) {
            throw new BadRequestException(
                `结算计划存在重复键：${Array.from(new Set(dupKeys)).join(',')}`,
            );
        }

        /**
         * 读取旧 settlement
         */
        const oldSettlements = await tx.orderSettlement.findMany({
            where: { orderId },
            select: {
                id: true,
                orderId: true,
                dispatchId: true,
                userId: true,
                settlementType: true,
                finalEarnings: true,
                settledAt: true,
            },
        });

        /**
         * FINAL_CONFIRM：
         * - 要求当前订单没有旧 settlement
         */
        if (mode === 'FINAL_CONFIRM') {
            if (oldSettlements.length > 0) {
                throw new BadRequestException(
                    '检测到已存在结算记录，首次确认结单仅允许全新写入，请走重算/修复流程',
                );
            }

            await tx.orderSettlement.createMany({
                data: settlementCreateData as any,
            });

            const createdSettlements = await tx.orderSettlement.findMany({
                where: { orderId, settlementBatchId },
                select: {
                    id: true,
                    userId: true,
                    dispatchId: true,
                    settlementType: true,
                    calculatedEarnings: true,
                    manualAdjustment: true,
                    finalEarnings: true,
                    clubEarnings: true,
                    csEarnings: true,
                    inviteEarnings: true,
                },
            });

            if (createdSettlements.length !== settlementCreateData.length) {
                throw new BadRequestException(
                    `首次写入结算条数不一致：期望=${settlementCreateData.length}, 实际=${createdSettlements.length}`,
                );
            }

            // ✅ 首次确认：沿用旧逻辑，正收益冻结
            const walletResults: any[] = [];
            for (const s of createdSettlements) {
                const freezeInfo = getSettlementFreezeInfo(Number(s.userId));
                const w = await this.wallet.applySettlementEarningToWalletV1({
                    tx,
                    userId: s.userId,
                    settlementId: s.id,
                    orderId,
                    dispatchId: s.dispatchId,
                    finalEarnings: Number(s.finalEarnings ?? 0),
                    unlockAt: freezeInfo.freezeEndAt,
                    freezeWhenPositive: true,
                });

                walletResults.push({
                    settlementId: s.id,
                    userId: s.userId,
                    dispatchId: s.dispatchId,
                    freezeDays: freezeInfo.freezeDays,
                    freezeEndAt: freezeInfo.freezeEndAt,
                    applyResult: w,
                });
            }

            // ✅ 合并原始计划里的辅助字段，供业绩/财务表使用
            const extraMap = new Map(
                settlementsToCreate.map((s: any) => [
                    `${Number(s.dispatchId)}_${Number(s.userId)}_${String(s.settlementType)}`,
                    s,
                ]),
            );

            const mergedSettlements = createdSettlements.map((s: any) => {
                const key = `${Number(s.dispatchId)}_${Number(s.userId)}_${String(s.settlementType)}`;
                const extra = extraMap.get(key) || {};
                return {
                    ...s,
                    ownerRoleType: extra.ownerRoleType,
                    contributionBaseAmount: extra.contributionBaseAmount,
                    commissionRate: extra.commissionRate,
                    grossPerformanceAmount: extra.grossPerformanceAmount,
                    netIncomeAmount: extra.netIncomeAmount,
                    clubEarnings: s.clubEarnings,
                    csEarnings: s.csEarnings,
                    inviteEarnings: s.inviteEarnings,
                    userName: extra.userName,
                };
            });
            const freezeInfoByUser = buildFreezeInfoList(createdSettlements);
            const summaryFreezeInfo = freezeInfoByUser.reduce((max: any, item: any) => (
                !max || item.freezeEndAt > max.freezeEndAt ? item : max
            ), null);

            return {
                mode,
                orderId,
                settlementBatchId,
                freezeDays: summaryFreezeInfo?.freezeDays ?? 7,
                freezeStartAt: summaryFreezeInfo?.freezeStartAt ?? null,
                freezeEndAt: summaryFreezeInfo?.freezeEndAt ?? null,
                freezeInfoByUser,
                walletResults,
                settlements: mergedSettlements,
                oldSettlementCount: 0,
                rebuiltSettlementCount: mergedSettlements.length,
            };
        }

        /**
         * REPAIR_REBUILD：
         * - 冲正旧钱包
         * - 删除旧 settlement
         * - 重建 settlement
         * - 重算钱包流水
         */
        if (mode === 'REPAIR_REBUILD') {
            if (!oldSettlements.length) {
                throw new BadRequestException('该订单不存在旧结算记录，无法执行重算修复');
            }

            const oldSettlementIds = oldSettlements.map((s: any) => s.id);
            const oldSettlementKeyById = new Map<number, string>(
                oldSettlements.map((s: any) => [
                    Number(s.id),
                    `${Number(s.dispatchId)}_${Number(s.userId)}_${String(s.settlementType)}`,
                ]),
            );

            /**
             * Step 1：生成旧钱包冲正计划
             */
            const rollbackSettlementResult = await this.wallet.rollbackOrderWalletImpactInTxV2({
                tx,
                settlementIds: oldSettlementIds,
                orderId,
            });

            /**
             * Step 2：执行旧结算主流水/解冻流水冲正
             */
            const reversalApplyResults: any[] = [];
            for (const plan of rollbackSettlementResult.reversalPlans ?? []) {
                const freezeInfo = getSettlementFreezeInfo(Number(plan.userId));
                const r = await this.wallet.applySettlementEarningToWalletV2({
                tx,
                userId: plan.userId,
                settlementId: plan.settlementId ?? null,
                orderId: plan.orderId ?? orderId,
                dispatchId: plan.dispatchId ?? null,
                finalEarnings: Number(plan.finalEarnings ?? 0),

                    unlockAt: freezeInfo.freezeEndAt,
                    freezeWhenPositive: true,
                    statusHint: plan.statusHint ?? null,

                    bizTypeOverride: WalletBizType.SETTLEMENT_REVERSAL,
                    sourceTypeOverride: plan.sourceTypeOverride,
                    sourceIdOverride: plan.sourceIdOverride,
                });

                reversalApplyResults.push({
                    ...plan,
                    applyResult: r,
                });
            }

            /**
             * Step 3：兜底识别历史残留流水并冲正
             */
            const windowEndAt = new Date();

            const orphanTxs = await tx.walletTransaction.findMany({
                where: {
                    orderId,
                    sourceType: 'ORDER_SETTLEMENT',
                    bizType: {
                        in: [
                            WalletBizType.SETTLEMENT_EARNING,
                            WalletBizType.SETTLEMENT_EARNING_BASE,
                            WalletBizType.SETTLEMENT_EARNING_CARRY,
                            WalletBizType.SETTLEMENT_EARNING_CS,
                            WalletBizType.SETTLEMENT_BOMB_LOSS,
                        ] as any,
                    },
                    status: { in: ['FROZEN', 'AVAILABLE'] as any },
                    createdAt: { lte: windowEndAt },
                    OR: [{ settlementId: null }, { settlementId: { notIn: oldSettlementIds } }],
                },
                select: {
                    id: true,
                    userId: true,
                    direction: true,
                    amount: true,
                    settlementId: true,
                    orderId: true,
                    dispatchId: true,
                },
            });

            const orphanReversalResults: any[] = [];
            for (const t of orphanTxs) {
                const amount = round2(Number(t.amount ?? 0));
                if (!t.userId || !amount) continue;
                const freezeInfo = getSettlementFreezeInfo(Number(t.userId));

                const originalDirection = String(t.direction);
                const reversalFinalEarnings = originalDirection === 'OUT' ? amount : -amount;

                const r = await this.wallet.applySettlementEarningToWalletV2({
                    tx,
                    userId: t.userId,
                    settlementId: t.settlementId ?? null,
                    orderId: t.orderId ?? orderId,
                    dispatchId: t.dispatchId ?? null,
                    finalEarnings: reversalFinalEarnings,

                    unlockAt: freezeInfo.freezeEndAt,
                    freezeWhenPositive: true,
                    statusHint: String(t.status) === 'FROZEN' ? 'FROZEN' : 'AVAILABLE',

                    bizTypeOverride: WalletBizType.SETTLEMENT_REVERSAL,
                    sourceTypeOverride: 'ORDER_SETTLEMENT_ORPHAN_REVERSAL',
                    sourceIdOverride: Number(t.id),
                });

                orphanReversalResults.push({
                    sourceTxId: t.id,
                    userId: t.userId,
                    amount,
                    originalDirection,
                    applyResult: r,
                });
            }

            /**
             * Step 4：删除旧 settlement（钱包流水不删）
             */
            const deleteOldSettlementResult = await tx.orderSettlement.deleteMany({
                where: { orderId },
            });

            /**
             * Step 5：重建 settlement
             */
            await tx.orderSettlement.createMany({
                data: settlementCreateData as any,
            });

            const createdSettlements = await tx.orderSettlement.findMany({
                where: { orderId, settlementBatchId },
                select: {
                    id: true,
                    userId: true,
                    dispatchId: true,
                    settlementType: true,
                    calculatedEarnings: true,
                    manualAdjustment: true,
                    finalEarnings: true,
                    clubEarnings: true,
                    csEarnings: true,
                    inviteEarnings: true,
                },
            });

            if (createdSettlements.length !== settlementCreateData.length) {
                throw new BadRequestException(
                    `重建结算条数不一致：期望=${settlementCreateData.length}, 实际=${createdSettlements.length}`,
                );
            }

            const recalcStatusHintByKey = new Map<string, 'FROZEN' | 'AVAILABLE'>();
            for (const item of rollbackSettlementResult.sourceSettlementStatusHints ?? []) {
                const key = oldSettlementKeyById.get(Number(item.settlementId));
                if (key) {
                    recalcStatusHintByKey.set(key, item.statusHint);
                }
            }

            /**
             * Step 6：写新“重算收益流水”
             * - 按旧结算状态决定是否冻结，避免把仍处于冻结态的重算结果直接落到可用余额
             */
            const recalcApplyResults: any[] = [];
            for (const s of createdSettlements) {
                const key = `${Number(s.dispatchId)}_${Number(s.userId)}_${String(s.settlementType)}`;
                const statusHint = recalcStatusHintByKey.get(key) ?? 'AVAILABLE';
                const freezeInfo = getSettlementFreezeInfo(Number(s.userId));
                const r = await this.wallet.applySettlementEarningToWalletV2({
                    tx,
                    userId: s.userId,
                    settlementId: s.id,
                    orderId,
                    dispatchId: s.dispatchId,
                    finalEarnings: Number(s.finalEarnings ?? 0),

                    unlockAt: freezeInfo.freezeEndAt,
                    freezeWhenPositive: true,
                    statusHint,

                    bizTypeOverride: WalletBizType.SETTLEMENT_RECALC,
                    sourceTypeOverride: 'ORDER_SETTLEMENT_RECALC',
                    sourceIdOverride: s.id,
                });

                recalcApplyResults.push({
                    settlementId: s.id,
                    userId: s.userId,
                    dispatchId: s.dispatchId,
                    finalEarnings: Number(s.finalEarnings ?? 0),
                    freezeDays: freezeInfo.freezeDays,
                    freezeEndAt: freezeInfo.freezeEndAt,
                    applyResult: r,
                });
            }

            /**
             * Step 7：合并计划里的辅助字段，供业绩/财务重建
             */
            const extraMap = new Map(
                settlementsToCreate.map((s: any) => [
                    `${Number(s.dispatchId)}_${Number(s.userId)}_${String(s.settlementType)}`,
                    s,
                ]),
            );

            const mergedSettlements = createdSettlements.map((s: any) => {
                const key = `${Number(s.dispatchId)}_${Number(s.userId)}_${String(s.settlementType)}`;
                const extra = extraMap.get(key) || {};
                return {
                    ...s,
                    ownerRoleType: extra.ownerRoleType,
                    contributionBaseAmount: extra.contributionBaseAmount,
                    commissionRate: extra.commissionRate,
                    grossPerformanceAmount: extra.grossPerformanceAmount,
                    netIncomeAmount: extra.netIncomeAmount,
                    clubEarnings: s.clubEarnings,
                    csEarnings: s.csEarnings,
                    inviteEarnings: s.inviteEarnings,
                    userName: extra.userName,
                };
            });
            const freezeInfoByUser = buildFreezeInfoList(createdSettlements);
            const summaryFreezeInfo = freezeInfoByUser.reduce((max: any, item: any) => (
                !max || item.freezeEndAt > max.freezeEndAt ? item : max
            ), null);

            return {
                mode,
                orderId,
                settlementBatchId,
                oldSettlementCount: oldSettlements.length,
                deletedOldSettlementCount: deleteOldSettlementResult.count,
                rebuiltSettlementCount: mergedSettlements.length,
                freezeDays: summaryFreezeInfo?.freezeDays ?? 7,
                freezeStartAt: summaryFreezeInfo?.freezeStartAt ?? null,
                freezeEndAt: summaryFreezeInfo?.freezeEndAt ?? null,
                freezeInfoByUser,
                rollbackSettlementResult,
                reversalApplyResults,
                orphanReversalResults,
                recalcApplyResults,
                settlements: mergedSettlements,
            };
        }

        throw new BadRequestException('未知 settlement 应用模式');
    }

    /**
     * 统一做 settlement 落库后的后置同步
     *
     * 说明：
     * - 重建业绩表
     * - upsert 财务表
     * - 写审计日志
     * - 可选更新订单状态
     */
    private async afterSettlementAppliedTx(params: {
        tx: any;
        orderId: number;
        operatorId: number;
        settlements: any[];
        action: string;
        remark?: string;
        orderStatusToUpdate?: OrderStatus;
        logExtra?: any;
    }) {
        const {
            tx,
            orderId,
            operatorId,
            settlements,
            action,
            remark,
            orderStatusToUpdate,
            logExtra,
        } = params;

        /**
         * 如果需要更新订单状态，则在这里统一更新
         */
        let updatedOrder: any = null;
        if (orderStatusToUpdate) {
            updatedOrder = await tx.order.update({
                where: { id: Number(orderId) },
                data: { status: orderStatusToUpdate },
                select: {
                    id: true,
                    status: true,
                    isPaid: true,
                    paidAmount: true,
                },
            });
        }

        /**
         * 重建业绩表 + 财务表
         */
        await this.rebuildPerformanceAndFinanceByOrderId({
            tx,
            orderId,
            settlements,
        });

        /**
         * 审计日志
         */
        await this.writeUserLog(tx, {
            userId: operatorId,
            action,
            targetType: 'ORDER',
            targetId: Number(orderId),
            oldData: null,
            newData: {
                settlementCount: settlements?.length ?? 0,
                orderStatusAfter: updatedOrder?.status ?? null,
                ...(logExtra || {}),
            } as any,
            remark: remark || action,
        });

        return {
            orderId: Number(orderId),
            settlementCount: settlements?.length ?? 0,
            orderStatusAfter: updatedOrder?.status ?? null,
        };
    }
    /*** -----------------------------
     * * ✅ 客服最终确认结单
     * * - controller 入口需要：confirmCompleteOrder(orderId, operatorId)
     * * - 幂等：已 COMPLETED 直接返回
     * * - 仅允许：COMPLETED_PENDING_CONFIRM -> COMPLETED
     * * - 并非必须收款，赠送单无法确认收款。
     * --------------------------*/

    async confirmCompleteOrder(
        orderId: number,
        operatorId: number,
        dto?: {
            remark?: string;
            paidAmount?: number;
            settlementBaseMode?: 'PAID_AMOUNT' | 'SETTLEMENT_BASE_AMOUNT' | string;
            confirmPaid?: any;
            modePlayAllocList?: any;
            playerEvaluations?: any[];
            autoConfirm?: boolean;
            orderTipEnabled?: boolean;
            orderTipUserIds?: any[];
            renewalAction?: string;
            invalidateRenewal?: boolean;
            renewalInvalidateReason?: string;
        },
    ) {
        orderId = Number(orderId);
        operatorId = Number(operatorId);

        if (!orderId) throw new BadRequestException('orderId 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');

        const remark = dto?.remark;
        const isAutoConfirm = Boolean(dto?.autoConfirm);

        const result = await this.prisma.$transaction(async (tx) => {
            /**
             * Step 0：并发保护
             */
            await this.lockOrderForSettlement(tx, orderId);
            await this.assertOrderNotSettlingOrThrow(
                tx,
                orderId,
                '订单正在结算处理中，禁止确认结单',
            );

            /**
             * Step 1：读取订单
             */
            const order = await this.loadOrderForSettlementTx({
                tx,
                orderId,
                scope: 'COMPLETED_AND_ARCHIVED',
            });

            /**
             * Step 2：状态校验
             */
            if (order.status === OrderStatus.COMPLETED) {
                throw new BadRequestException('已确认结单，若有结算问题请通过结算工具重算');
            }

            const PENDING: any = (OrderStatus as any).COMPLETED_PENDING_CONFIRM;
            if (!PENDING) {
                throw new BadRequestException('当前系统未启用“已结单待确认”状态，无法确认结单');
            }

            if (order.status !== PENDING) {
                throw new BadRequestException('仅“已结单待确认”阶段允许确认结单');
            }

            /**
             * Step 3：确认结单时允许小时单补收
             */
            const billingMode: BillingMode | undefined = this.getBillingModeFromOrder(order);
            if (!billingMode) throw new BadRequestException('订单缺少 billingMode');

            const newPaidAmount =
                dto?.paidAmount === undefined || dto?.paidAmount === null
                    ? undefined
                    : Number(dto.paidAmount);

            if (newPaidAmount !== undefined && billingMode === BillingMode.HOURLY) {
                const oldPaid = Number((order as any).paidAmount ?? 0);

                if (!Number.isFinite(newPaidAmount) || newPaidAmount < 0) {
                    throw new BadRequestException('paidAmount 非法');
                }

                if (newPaidAmount > oldPaid) {
                    await this.applyPaidAmountUpdateInTx(
                        tx,
                        order,
                        newPaidAmount,
                        operatorId,
                        remark,
                        dto?.confirmPaid,
                    );
                } else if (newPaidAmount < oldPaid) {
                    throw new BadRequestException('确认结单时实付金额仅允许不变或增加，不允许减少');
                }
            }

            /**
             * Step 4：再读一次订单，确保拿到补收后的最新 paidAmount / isPaid
             */
            const latestOrder = await this.loadOrderForSettlementTx({
                tx,
                orderId,
                scope: 'COMPLETED_AND_ARCHIVED',
            });

            const settlementBaseMode = this.normalizeSettlementBaseMode(dto?.settlementBaseMode);
            const chosenSettlementBaseAmount = this.getSettlementBaseAmountForConfirmation(
                latestOrder,
                settlementBaseMode,
            );

            if (!Number.isFinite(chosenSettlementBaseAmount) || chosenSettlementBaseAmount <= 0) {
                throw new BadRequestException('订单结算基数非法');
            }

            const latestSettlementBaseAmount = Number((latestOrder as any).settlementBaseAmount ?? 0);
            if (
                settlementBaseMode === 'PAID_AMOUNT' ||
                !Number.isFinite(latestSettlementBaseAmount) ||
                Math.abs(latestSettlementBaseAmount - chosenSettlementBaseAmount) > 1e-9
            ) {
                await tx.order.update({
                    where: {id: orderId},
                    data: {
                        settlementBaseAmount: chosenSettlementBaseAmount,
                    },
                });
                (latestOrder as any).settlementBaseAmount = chosenSettlementBaseAmount;
            }

            if (!this.isOrderEffectivelyPaidOrGifted(latestOrder as any)) {
                throw new BadRequestException('未收款订单不允许最终确认结单');
            }

            try {
                /**
                 * Step 5：构建 settlement 计划
                 */
                const { settlementsToCreate, evaluationRows } = await this.buildSettlementPlanFromOrder({
                    order: latestOrder,
                    modePlayAllocList: dto?.modePlayAllocList,
                    playerEvaluations: dto?.playerEvaluations,
                    autoConfirm: isAutoConfirm,
                    orderTipEnabled: dto?.orderTipEnabled,
                    orderTipUserIds: dto?.orderTipUserIds,
                });

                /**
                 * Step 6：首次确认结单，应用 settlement
                 */
                const result = await this.applySettlementPlanTx({
                    tx,
                    order: latestOrder,
                    operatorId,
                    settlementsToCreate,
                    mode: 'FINAL_CONFIRM',
                    reason: remark,
                });

                const renewalResult = await this.processRenewalAtConfirmTx({
                    tx,
                    order: latestOrder,
                    settlementBatchId: result.settlementBatchId,
                    operatorId,
                    mode: this.resolveRenewalConfirmMode(dto),
                    invalidateReason: dto?.renewalInvalidateReason || remark,
                });

                if (evaluationRows.length) {
                    for (const item of evaluationRows) {
                        await tx.orderPlayerEvaluation.upsert({
                            where: {
                                orderId_dispatchId_playerUserId: {
                                    orderId: Number(orderId),
                                    dispatchId: Number(item.dispatchId),
                                    playerUserId: Number(item.playerUserId),
                                },
                            },
                            update: {
                                evaluatorId: operatorId,
                                score: Number(item.score ?? 0),
                                ratingLabel: String(item.ratingLabel || 'MEDIUM'),
                                afterSaleHandled: Boolean(item.afterSaleHandled),
                                afterSaleAction: item.afterSaleAction || null,
                                responsibleUserIds: Array.isArray(item.responsibleUserIds) ? item.responsibleUserIds : [],
                                tippedUserIds: Array.isArray(item.tippedUserIds) ? item.tippedUserIds : [],
                                tipPoolAmount: item.tipPoolAmount ?? null,
                                tipAmount: item.tipAmount ?? null,
                                penaltyAmount: item.penaltyAmount ?? null,
                                maintenanceFeeAmount: item.maintenanceFeeAmount ?? null,
                                reviewRemark: item.reviewRemark || null,
                            },
                            create: {
                                orderId: Number(orderId),
                                dispatchId: Number(item.dispatchId),
                                playerUserId: Number(item.playerUserId),
                                evaluatorId: operatorId,
                                score: Number(item.score ?? 0),
                                ratingLabel: String(item.ratingLabel || 'MEDIUM'),
                                afterSaleHandled: Boolean(item.afterSaleHandled),
                                afterSaleAction: item.afterSaleAction || null,
                                responsibleUserIds: Array.isArray(item.responsibleUserIds) ? item.responsibleUserIds : [],
                                tippedUserIds: Array.isArray(item.tippedUserIds) ? item.tippedUserIds : [],
                                tipPoolAmount: item.tipPoolAmount ?? null,
                                tipAmount: item.tipAmount ?? null,
                                penaltyAmount: item.penaltyAmount ?? null,
                                maintenanceFeeAmount: item.maintenanceFeeAmount ?? null,
                                reviewRemark: item.reviewRemark || null,
                            },
                        });
                    }
                }

                /**
                 * Step 7：后置同步
                 * - 更新订单状态为 COMPLETED
                 * - 重建业绩 / 财务
                 * - 写日志
                 */
                await this.afterSettlementAppliedTx({
                    tx,
                    orderId,
                    operatorId,
                    settlements: result.settlements || [],
                    action: isAutoConfirm ? 'SYSTEM_AUTO_CONFIRM_COMPLETE_ORDER_72H' : 'CONFIRM_COMPLETE_ORDER_V3',
                    remark: remark || (isAutoConfirm ? '系统72小时自动确认结单' : '客服确认最终结单'),
                    orderStatusToUpdate: OrderStatus.COMPLETED,
                    logExtra: {
                        settlementBatchId: result.settlementBatchId,
                        freezeDays: result.freezeDays,
                        freezeStartAt: result.freezeStartAt,
                        freezeEndAt: result.freezeEndAt,
                        confirmMode: isAutoConfirm ? 'AUTO' : 'MANUAL',
                        renewalResult,
                    },
                });

                await this.applyOrderMemberBenefitsTx(tx, latestOrder);

                return {
                    orderId,
                    status: OrderStatus.COMPLETED,
                    settlementBatchId: result.settlementBatchId,
                    rebuiltSettlementCount: result.rebuiltSettlementCount,
                    freezeDays: result.freezeDays,
                    freezeStartAt: result.freezeStartAt,
                    freezeEndAt: result.freezeEndAt,
                    confirmMode: isAutoConfirm ? 'AUTO' : 'MANUAL',
                    renewalResult,
                };
            } catch (err: any) {
                const errMsg = String(err?.message || err || '');
                if (
                    err instanceof BadRequestException &&
                    (errMsg.includes('订单结算基数与实付金额不一致') ||
                        errMsg.includes('订单结算基数与结算金额不一致'))
                ) {
                    const preview = await this.buildSettlementPlanFromOrder({
                        order: latestOrder,
                        modePlayAllocList: dto?.modePlayAllocList,
                        playerEvaluations: dto?.playerEvaluations,
                        autoConfirm: isAutoConfirm,
                        orderTipEnabled: dto?.orderTipEnabled,
                        orderTipUserIds: dto?.orderTipUserIds,
                        skipValidation: true,
                    });

                    return {
                        previewOnly: true,
                        orderId,
                        errorMessage: errMsg,
                        status: latestOrder.status,
                        orderStatusAfter: latestOrder.status,
                        settlementBatchId: null,
                        settlementCount: preview.settlementsToCreate?.length ?? 0,
                        settlements: preview.settlementsToCreate ?? [],
                        evaluationRows: preview.evaluationRows ?? [],
                        tipPoolTotal: preview.tipPoolTotal ?? 0,
                        csPoolTotal: preview.csPoolTotal ?? 0,
                        validation: preview.validation ?? null,
                    };
                }

                throw err;
            }
        });

        if (!result?.previewOnly && String(result?.status || '') === String(OrderStatus.COMPLETED)) {
            try {
                await this.miniSubscribeMessageService.pushOrderProgressMessage(
                    Number(orderId),
                    '订单已完成，欢迎前往评价本次服务',
                    '待评价',
                );
            } catch (e: any) {
                console.error('[notify][mini-order-progress][confirm-complete] failed', e?.message || e);
            }
            try {
                const orderAfter = await this.prisma.order.findUnique({
                    where: { id: Number(orderId) },
                    select: {
                        id: true,
                        customerUserId: true,
                        paidAmount: true,
                        finalPayableAmount: true,
                        isTestPayment: true,
                    },
                });
                if (orderAfter?.customerUserId) {
                    const pointAccount = await this.prisma.memberPointAccount.findUnique({
                        where: { userId: Number(orderAfter.customerUserId) },
                        select: { availablePoints: true },
                    });
                    const profile = await this.prisma.memberProfile.findUnique({
                        where: { userId: Number(orderAfter.customerUserId) },
                        select: { annualContribution: true },
                    });
                    const benefitBaseAmount = this.resolveMemberBenefitBaseAmount(orderAfter);
                    const points = this.getOrderRewardPointsByPaidAmount(benefitBaseAmount);
                    const growthValue = this.getMemberGrowthValueByPaidAmount(benefitBaseAmount);
                    await this.miniSubscribeMessageService.pushMemberAssetMessage({
                        userId: Number(orderAfter.customerUserId),
                        assetType: '订单奖励已到账',
                        changeAmount: `积分+${points} / 成长值+${growthValue}`,
                        balanceAfter: `积分余额 ${Number(pointAccount?.availablePoints || 0)} / 成长值 ${Number(profile?.annualContribution || 0)}`,
                        targetType: 'ORDER',
                        targetId: Number(orderAfter.id),
                        pageQuery: { id: orderAfter.id },
                        remark: `订单完成后已发放积分与会员成长值`,
                    });
                }
            } catch (e: any) {
                console.error('[notify][mini-member-asset][confirm-complete] failed', e?.message || e);
            }
        }

        return result;
    }

    private buildEvaluationDateRange(scope?: string, startAt?: string, endAt?: string) {
        const from = startAt ? new Date(startAt) : null;
        const to = endAt ? new Date(endAt) : null;

        if (from || to) {
            const range: any = {};
            if (from && !Number.isNaN(from.getTime())) range.gte = from;
            if (to && !Number.isNaN(to.getTime())) range.lte = to;
            return range;
        }

        const now = new Date();
        const s = String(scope || 'ALL').toUpperCase();
        if (s === 'ALL') return {};

        const start = new Date(now);
        start.setHours(0, 0, 0, 0);

        if (s === 'WEEK') {
            const day = start.getDay();
            const diff = day === 0 ? 6 : day - 1;
            start.setDate(start.getDate() - diff);
            return { gte: start };
        }

        if (s === 'MONTH') {
            start.setDate(1);
            return { gte: start };
        }

        return {};
    }

    async getPlayerEvaluationLeaderboard(params: {
        scope?: string;
        startAt?: string;
        endAt?: string;
        keyword?: string;
        page?: number;
        limit?: number;
    }) {
        const page = Math.max(1, Number(params.page ?? 1));
        const limit = Math.min(100, Math.max(1, Number(params.limit ?? 20)));
        const where: any = {};
        const createdAtRange = this.buildEvaluationDateRange(params.scope, params.startAt, params.endAt);
        if (Object.keys(createdAtRange).length) {
            where.createdAt = createdAtRange;
        }

        const rows = await this.prisma.orderPlayerEvaluation.findMany({
            where,
            include: {
                player: {
                    select: {
                        id: true,
                        name: true,
                        avatar: true,
                        rating: true,
                        staffRating: { select: { rate: true } },
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });

        const keyword = String(params.keyword || '').trim();
        const aggMap = new Map<number, any>();

        for (const row of rows) {
            const player = row.player;
            if (keyword) {
                const hit =
                    String(player?.name || '').includes(keyword) ||
                    String(player?.id || '').includes(keyword);
                if (!hit) continue;
            }

            const userId = Number(row.playerUserId);
            const item = aggMap.get(userId) || {
                userId,
                player: player || null,
                totalCount: 0,
                scoreSum: 0,
                goodCount: 0,
                mediumCount: 0,
                badCount: 0,
                afterSaleCount: 0,
                tipCount: 0,
                tipTotal: 0,
                penaltyTotal: 0,
                maintenanceFeeTotal: 0,
            };

            const score = Number(row.score || 0);
            item.totalCount += 1;
            item.scoreSum += score;
            if (score >= 4) item.goodCount += 1;
            else if (score === 3) item.mediumCount += 1;
            else item.badCount += 1;

            if (row.afterSaleHandled) item.afterSaleCount += 1;
            if (Number(row.tipAmount || 0) > 0) item.tipCount += 1;
            item.tipTotal += Number(row.tipAmount || 0);
            item.penaltyTotal += Number(row.penaltyAmount || 0);
            item.maintenanceFeeTotal += Number(row.maintenanceFeeAmount || 0);

            aggMap.set(userId, item);
        }

        const list = Array.from(aggMap.values()).map((item) => {
            const totalCount = Number(item.totalCount || 0);
            const scoreAvg = totalCount > 0 ? round2(Number(item.scoreSum || 0) / totalCount) : 0;
            const goodRate = totalCount > 0 ? round2((Number(item.goodCount || 0) / totalCount) * 100) : 0;
            return {
                ...item,
                ratingAvg: scoreAvg,
                goodRate,
                badRate: totalCount > 0 ? round2((Number(item.badCount || 0) / totalCount) * 100) : 0,
            };
        }).sort((a, b) => {
            const scoreDiff = Number(b.ratingAvg || 0) - Number(a.ratingAvg || 0);
            if (scoreDiff !== 0) return scoreDiff;
            const goodRateDiff = Number(b.goodRate || 0) - Number(a.goodRate || 0);
            if (goodRateDiff !== 0) return goodRateDiff;
            const goodCountDiff = Number(b.goodCount || 0) - Number(a.goodCount || 0);
            if (goodCountDiff !== 0) return goodCountDiff;
            return Number(b.tipTotal || 0) - Number(a.tipTotal || 0);
        });

        const total = list.length;
        const items = list.slice((page - 1) * limit, (page - 1) * limit + limit);

        return {
            scope: String(params.scope || 'ALL').toUpperCase(),
            page,
            limit,
            total,
            items,
            summary: {
                totalPlayers: total,
                totalReviews: rows.length,
                totalTips: round2(list.reduce((sum, it) => sum + Number(it.tipTotal || 0), 0)),
            },
        };
    }

    async getRenewalLeaderboard(params: {
        dimension?: string;
        startAt?: string;
        endAt?: string;
        keyword?: string;
        page?: number;
        limit?: number;
    }) {
        const page = Math.max(1, Number(params.page ?? 1));
        const limit = Math.min(100, Math.max(1, Number(params.limit ?? 20)));
        const dimension = ['DAY', 'WEEK', 'MONTH'].includes(String(params.dimension || '').toUpperCase())
            ? String(params.dimension || '').toUpperCase()
            : 'DAY';
        const settledAtRange = this.buildEvaluationDateRange('CUSTOM', params.startAt, params.endAt);
        const where: any = { status: 'SETTLED' };
        if (Object.keys(settledAtRange).length) {
            where.settledAt = settledAtRange;
        }

        const groups = await this.prisma.orderRenewalGroup.findMany({
            where,
            include: {
                order: {
                    select: {
                        id: true,
                        autoSerial: true,
                        paidAmount: true,
                        receivableAmount: true,
                        createdAt: true,
                    },
                },
            },
            orderBy: [{ settledAt: 'desc' }, { id: 'desc' }],
        });

        const keyword = String(params.keyword || '').trim();
        const aggMap = new Map<string, any>();
        const normalizeMemberName = (value: any) => {
            if (value === null || value === undefined) return '';
            if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
            if (typeof value === 'object') {
                return String(
                    value.nickname ??
                    value.name ??
                    value.realName ??
                    value.displayName ??
                    value.username ??
                    value.userId ??
                    value.id ??
                    '',
                ).trim();
            }
            return String(value || '').trim();
        };
        const normalizeMemberId = (value: any) => {
            if (value === null || value === undefined) return '';
            if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
            if (typeof value === 'object') {
                return String(value.userId ?? value.id ?? value.value ?? '').trim();
            }
            return String(value || '').trim();
        };

        for (const group of groups) {
            const memberNames = (Array.isArray(group.memberNamesSnapshot) ? group.memberNamesSnapshot : [])
                .map(normalizeMemberName)
                .filter(Boolean);
            const memberUserIds = (Array.isArray(group.memberUserIds) ? group.memberUserIds : [])
                .map(normalizeMemberId)
                .filter(Boolean);
            const memberIdText = memberUserIds.join(',');
            const groupKey = String(group.groupKey || memberIdText || group.id);
            const memberNameText = memberNames.join('、');
            if (keyword) {
                const hit =
                    groupKey.includes(keyword) ||
                    memberNameText.includes(keyword) ||
                    memberIdText.includes(keyword) ||
                    String(group.order?.autoSerial || '').includes(keyword);
                if (!hit) continue;
            }

            const item = aggMap.get(groupKey) || {
                groupKey,
                memberUserIds,
                memberNames,
                memberNameText: memberNameText || groupKey,
                renewalOrderCount: 0,
                renewalAmount: 0,
                bonusTotalAmount: 0,
                avgBonusRate: 0,
                bonusRateSum: 0,
                lastSettledAt: null,
                lastOrderId: null,
                lastOrderAutoSerial: null,
            };

            const renewalOrderCount = Math.max(1, Number(group.renewalOrderCount || 0));
            item.renewalOrderCount += renewalOrderCount;
            item.renewalAmount += Number(group.renewalAmount || group.bonusBaseAmount || 0);
            item.bonusTotalAmount += Number(group.bonusTotalAmount || 0);
            item.bonusRateSum += Number(group.bonusRate || 0) * renewalOrderCount;

            const settledAt = group.settledAt || group.updatedAt || group.createdAt;
            if (!item.lastSettledAt || new Date(settledAt).getTime() > new Date(item.lastSettledAt).getTime()) {
                item.lastSettledAt = settledAt;
                item.lastOrderId = group.orderId;
                item.lastOrderAutoSerial = group.order?.autoSerial || `#${group.orderId}`;
            }

            aggMap.set(groupKey, item);
        }

        const list = Array.from(aggMap.values()).map((item) => ({
            ...item,
            renewalAmount: round2(item.renewalAmount),
            bonusTotalAmount: round2(item.bonusTotalAmount),
            avgBonusRate: item.renewalOrderCount > 0 ? round2((item.bonusRateSum / item.renewalOrderCount) * 100) : 0,
        })).sort((a, b) => {
            const countDiff = Number(b.renewalOrderCount || 0) - Number(a.renewalOrderCount || 0);
            if (countDiff !== 0) return countDiff;
            const amountDiff = Number(b.renewalAmount || 0) - Number(a.renewalAmount || 0);
            if (amountDiff !== 0) return amountDiff;
            return Number(b.bonusTotalAmount || 0) - Number(a.bonusTotalAmount || 0);
        }).map((item, index) => ({
            ...item,
            rank: index + 1,
        }));

        const total = list.length;
        const items = list.slice((page - 1) * limit, (page - 1) * limit + limit);

        return {
            dimension,
            startAt: params.startAt || null,
            endAt: params.endAt || null,
            page,
            limit,
            total,
            items,
            summary: {
                totalGroups: total,
                totalRenewalOrders: round2(list.reduce((sum, item) => sum + Number(item.renewalOrderCount || 0), 0)),
                totalRenewalAmount: round2(list.reduce((sum, item) => sum + Number(item.renewalAmount || 0), 0)),
                totalBonusAmount: round2(list.reduce((sum, item) => sum + Number(item.bonusTotalAmount || 0), 0)),
            },
        };
    }
    
    
    /**
     * ✅ 钱包对齐修复
     * - 不再考虑其他场景和状态，统一重算(并查询是否已经有对应的结算流水，如果有，直接删除或覆盖)。
     * 1. 先查询出派单记录所有的轮次和每轮的参与者
     * 2. 获取计算的必须的重要参数。
     * - 区分订单类型：保底单→ 订单总金额、订单可分配额度=订单总保底额度、对应的抽成比例（订单设定的抽成比例 customClubRate > 项目的抽成比例 GameProject.clubRate > 参与者对应的等级比例 User.staffRating.rate）
     * 3. 计算收益：
     * 3.1 保底单计算(每轮进度可能存在负数，则整个订单的保底跟着增加。可分配资金也会增加)
     *    保底单存单计算公式：单人收入=本轮贡献/(订单保底/订单金额)/本轮参与人数*对应的抽成比例
     * 3.1.1 保底单重算(已存单)：先获取状态为已存单的所有轮次，按顺序计算，获取每轮其参与者的贡献(多人均分)，按照上面公式进行计算。同时订单剩余可分配额度 = 订单可分配额度 - 本轮贡献。
     *     保底单结单计算公式：单人收入=剩余可分配额度(或者订单剩余金额)/(订单保底/订单金额)/本轮参与人数*对应的抽成比例
     * 3.1.2 保底单重算(已结单)：最后一轮一定是已结单，并且订单剩余可分配额度一定是大于0。
     * 3.2 小时单计算
     * 本轮时长计算规则：(存/结单时间-接单时间，取小时整数后，分钟数最低0.5小时为最小单位。低于18分钟不计算，18-45分钟算0.5小时，超出45分钟不足60分钟算一小时)
     * 订单剩余可分配资金需要记录，用作最后一组存单使用，记录方式，总实收
     * 3.2.1 小时单存单计算公式：单人收入=本轮时长*(总收益/总时长)/本轮参与人数*对应的抽成比例
     * 3.2.2 小时单结单计算公式：单人收入=订单剩余金额/本轮参与人数*对应的抽成比例
     * 3.3 dryRun=true时，返回该订单的已有分红数据，只展示差异。
     * - 幂等：重复执行不会重复计入余额
     * -  dryRun=false或为空时，再落库。
     */

    async repairWalletForOrderSettlementsV2(params: {
        orderId: number;
        operatorId: number;
        reason?: string;
        dryRun?: boolean;
        applyRepair?: boolean;
        settlementBaseAmount?: number;
        type?: '' | 'RECALCULATE';
        scope?: 'COMPLETED_AND_ARCHIVED' | 'COMPLETED_ONLY' | 'ARCHIVED_ONLY';
        modePlayAllocList?: any;
        playerEvaluations?: any[];
        orderTipEnabled?: boolean;
        orderTipUserIds?: any[];
        invalidateRenewal?: boolean;
        renewalInvalidateReason?: string;
    }) {
        const {
            orderId,
            operatorId,
            reason,
            dryRun = false,
            applyRepair = false,
            scope = 'COMPLETED_AND_ARCHIVED',
            settlementBaseAmount,
            modePlayAllocList,
            playerEvaluations,
            orderTipEnabled,
            orderTipUserIds,
            invalidateRenewal,
            renewalInvalidateReason,
        } = params;
        const parsedSettlementBaseAmount = Number(settlementBaseAmount ?? 0);
        const hasExplicitSettlementBaseAmount = Number.isFinite(parsedSettlementBaseAmount) && parsedSettlementBaseAmount > 0;
        const explicitSettlementBaseAmount = hasExplicitSettlementBaseAmount
            ? this.toDecimal2(parsedSettlementBaseAmount)
            : null;

        const normalizePlayerEvaluations = (rows: any[] = []) => {
            return (Array.isArray(rows) ? rows : [])
                .map((item: any) => ({
                    dispatchId: Number(item?.dispatchId ?? 0),
                    playerUserId: Number(item?.playerUserId ?? 0),
                    score: Number(item?.score ?? 0),
                    ratingLabel: String(item?.ratingLabel ?? ''),
                    afterSaleHandled: Boolean(item?.afterSaleHandled),
                    afterSaleAction: item?.afterSaleAction || null,
                    responsibleUserIds: this.normalizeIdArray(item?.responsibleUserIds),
                    tippedUserIds: this.normalizeIdArray(item?.tippedUserIds),
                }))
                .sort((a, b) => (
                    a.dispatchId - b.dispatchId ||
                    a.playerUserId - b.playerUserId
                ));
        };

        const normalizeModePlayAlloc = (rows: any[] = []) => {
            return (Array.isArray(rows) ? rows : [])
                .map((item: any) => ({
                    dispatchId: Number(item?.dispatchId ?? 0),
                    income: Number(item?.income ?? 0),
                }))
                .sort((a, b) => a.dispatchId - b.dispatchId);
        };

        return this.prisma.$transaction(async (tx) => {
            /**
             * Step 0：并发保护
             */
            await this.assertOrderNotSettlingOrThrow(
                tx,
                orderId,
                '订单正在结算处理中，禁止历史结算修复',
            );

            /**
             * Step 1：读取订单
             */
            const order = await this.loadOrderForSettlementTx({
                tx,
                orderId,
                scope,
            });

            const resolvedRepairSettlementBaseAmount = explicitSettlementBaseAmount
                ?? this.toDecimal2(this.getSettlementBaseAmountFromOrder(order));

            const repairOrder = {
                ...order,
                settlementBaseAmount: resolvedRepairSettlementBaseAmount,
            };

            /**
             * Step 2：dryRun / applyRepair 共用 settlement 计划
             */
            const { billingMode, settlementsToCreate } = await this.buildSettlementPlanFromOrder({
                order: repairOrder,
                modePlayAllocList,
                playerEvaluations,
                orderTipEnabled,
                orderTipUserIds,
            });

            /**
             * Step 3：dryRun
             * - 只缓存
             * - 只返回 plan
             */
            if (dryRun && !applyRepair) {
                this.settlementRepairCache.set(orderId, {
                    settlementsToCreate,
                    snapshot: {
                        orderId: Number(order.id),
                        updatedAt: order.updatedAt,
                        paidAmount: Number(order.paidAmount ?? 0),
                        settlementBaseAmount: Number(resolvedRepairSettlementBaseAmount ?? 0),
                        status: order.status,
                        dispatchCount: Number(order.dispatches?.length ?? 0),
                        modePlayAllocList: normalizeModePlayAlloc(modePlayAllocList),
                        playerEvaluations: normalizePlayerEvaluations(playerEvaluations),
                        orderTipEnabled: Boolean(orderTipEnabled),
                        orderTipUserIds: this.normalizeIdArray(orderTipUserIds),
                    } as any,
                });

                const plan = compareSettlementsToPlan({
                    existingSettlements: order.settlements,
                    settlementsToCreate,
                    dispatches: order.dispatches,
                });

                return {
                    dryRun: true,
                    orderId,
                    billingMode,
                    scope,
                    orderSummary: {
                        orderId: Number(order.id),
                        paidAmount: Number(order.paidAmount ?? 0),
                        orderQuantity: order.orderQuantity,
                        baseAmountWan: order.baseAmountWan ?? null,
                        projectId: order.projectId ?? null,
                    },
                    plan,
                };
            }

            /**
             * Step 4：applyRepair
             * - 优先使用缓存
             * - 校验缓存对应的订单关键数据是否发生变化
             */
            let planToApply = settlementsToCreate;

            if (applyRepair) {
                const cached = this.settlementRepairCache.get(orderId);

                if (!cached || !Array.isArray(cached.settlementsToCreate) || !cached.settlementsToCreate.length) {
                    throw new BadRequestException('未找到可应用的修复结果，请先 dryRun');
                }

                const snap:
                    | {
                    orderId: number;
                    updatedAt: Date | null;
                    paidAmount: number;
                    settlementBaseAmount: number;
                    status: any;
                    dispatchCount: number;
                    modePlayAllocList?: any[];
                    playerEvaluations?: any[];
                    orderTipEnabled?: boolean;
                    orderTipUserIds?: number[];
                }
                    | undefined = cached.snapshot;

                const currentUpdatedAt = order.updatedAt
                    ? new Date(order.updatedAt).getTime()
                    : 0;

                const cachedUpdatedAt = snap?.updatedAt
                    ? new Date(snap.updatedAt).getTime()
                    : 0;

                if (
                    Number(snap?.orderId ?? 0) !== Number(order.id) ||
                    Number(snap?.paidAmount ?? 0) !== Number(order.paidAmount ?? 0) ||
                    Number(snap?.settlementBaseAmount ?? 0) !== Number(resolvedRepairSettlementBaseAmount ?? 0) ||
                    String(snap?.status ?? '') !== String(order.status ?? '') ||
                    Number(snap?.dispatchCount ?? 0) !== Number(order.dispatches?.length ?? 0) ||
                    currentUpdatedAt !== cachedUpdatedAt ||
                    JSON.stringify(snap?.modePlayAllocList ?? []) !== JSON.stringify(normalizeModePlayAlloc(modePlayAllocList)) ||
                    JSON.stringify(snap?.playerEvaluations ?? []) !== JSON.stringify(normalizePlayerEvaluations(playerEvaluations)) ||
                    Boolean(snap?.orderTipEnabled ?? false) !== Boolean(orderTipEnabled) ||
                    JSON.stringify(snap?.orderTipUserIds ?? []) !== JSON.stringify(this.normalizeIdArray(orderTipUserIds))
                ) {
                    throw new BadRequestException('预览结果已失效，请重新 dryRun 后再 applyRepair');
                }

                planToApply = cached.settlementsToCreate;
            }

            if (explicitSettlementBaseAmount) {
                await tx.order.update({
                    where: { id: orderId },
                    data: { settlementBaseAmount: explicitSettlementBaseAmount },
                });
            }

            /**
             * Step 5：执行重算修复
             */
            const result = await this.applySettlementPlanTx({
                tx,
                order,
                operatorId,
                settlementsToCreate: planToApply,
                mode: 'REPAIR_REBUILD',
                reason,
            });

            const renewalRepairResult = invalidateRenewal
                ? await this.reverseRenewalBonusesTx({
                    tx,
                    orderId,
                    operatorId,
                    reason: renewalInvalidateReason || reason || 'RENEWAL_INVALIDATED_BY_RECALCULATION',
                    groupStatusAfter: 'INVALIDATED',
                })
                : null;

            /**
             * Step 6：后置同步
             * - 注意：重算不改订单状态
             * - 只重建业绩 / 财务 / 写日志
             */
            await this.afterSettlementAppliedTx({
                tx,
                orderId,
                operatorId,
                settlements: result.settlements || [],
                action: 'REPAIR_ORDER_SETTLEMENTS_V3',
                remark: reason || '历史结算重算修复',
                logExtra: {
                    settlementBatchId: result.settlementBatchId,
                    oldSettlementCount: result.oldSettlementCount,
                    deletedOldSettlementCount: result.deletedOldSettlementCount,
                    rebuiltSettlementCount: result.rebuiltSettlementCount,
                    renewalRepairResult,
                },
            });

            return {
                mode: 'REPAIR_REBUILD',
                orderId,
                billingMode,
                settlementBatchId: result.settlementBatchId,
                oldSettlementCount: result.oldSettlementCount,
                deletedOldSettlementCount: result.deletedOldSettlementCount,
                rebuiltSettlementCount: result.rebuiltSettlementCount,
                renewalRepairResult,
            };
        });
    }

    /**
     * 清理某个订单历史结算产生的副作用数据（最小 DB 操作版）
     * - 删除 WalletTransaction（按 settlementId）
     *   - WalletHold 会因 earningTx onDelete: Cascade 自动删除
     * - 删除 OrderSettlement
     *
     * ⚠️ 注意：此方法不会自动回算 WalletAccount 余额
     *          必须在同一事务里紧接着“重写新流水 + 更新 WalletAccount”，否则余额会不一致
     */
    async cleanupOrderSettlementSideEffects(params: {
        tx: any;
        orderId: number;
    })
    {
        const {tx, orderId} = params;

        // 1) 查 settlementIds（只查 id）
        const settlements = await tx.orderSettlement.findMany({
            where: {orderId},
            select: {id: true},
        });

        if (!settlements?.length) {
            return {
                settlementCount: 0,
                walletTxDeleted: 0,
                settlementDeleted: 0,
                note: '该订单下不存在历史结算数据',
            };
        }

        const settlementIds = settlements.map((s: any) => s.id);

        // 2) 删流水（会级联删 WalletHold）
        const walletTxResult = await tx.walletTransaction.deleteMany({
            where: {settlementId: {in: settlementIds}},
        });

        // 3) 删结算
        const settlementResult = await tx.orderSettlement.deleteMany({
            where: {id: {in: settlementIds}},
        });

        return {
            settlementCount: settlementIds.length,
            walletTxDeleted: walletTxResult?.count ?? 0,
            settlementDeleted: settlementResult?.count ?? 0,
            note: 'WalletHold 由 earningTxId 外键级联删除',
        };
    }



    /** ====================== 陪玩端（不应被管理端 orders 权限误伤） ====================== */

    /*** -----------------------------
     * 陪玩接单
     * -----------------------------*/
    async acceptDispatch(
        dispatchId: number,
        userId: number,
        dto: AcceptDispatchDto,
        payload?: string | { remark?: string },
    ) {
        const dispatch = await this.prisma.orderDispatch.findUnique({
            where: {id: dispatchId},
            include: {
                order: true,
                participants: true,
            },
        });

        if (!dispatch) throw new NotFoundException('派单批次不存在');

        this.ensureDispatchStatus(dispatch, [DispatchStatus.WAIT_ACCEPT, DispatchStatus.ACCEPTED], '当前状态不可接单');

        const participant = dispatch.participants.find((p) => p.userId === userId);
        if (Number(dispatch.order.currentDispatchId || 0) !== Number(dispatch.id)) {
            throw new BadRequestException('当前派单已更新，请刷新后重试');
        }
        if (!participant || participant.isActive === false || !!participant.rejectedAt) {
            throw new BadRequestException('不是该订单当前有效参与者');
        }

        if (participant.acceptedAt) {
            // 幂等：已接单直接返回
            return this.getDispatchWithParticipants(dispatchId);
        }

        await this.prisma.orderParticipant.update({
            where: {id: participant.id},
            data: {acceptedAt: new Date()},
        });

        await this.prisma.user.update({
            where: {id: userId},
            data: {
                workStatus: 'WORKING' as any,
                staffDormantFreezeBaseAt: null,
            },
        });

        // 判断是否全员接单完成
        const refreshed = await this.prisma.orderDispatch.findUnique({
            where: {id: dispatchId},
            include: {participants: true, order: true},
        });
        if (!refreshed) throw new NotFoundException('派单批次不存在');

        const active = (refreshed.participants || []).filter((p: any) => p?.isActive !== false && !p?.rejectedAt);
        const allAccepted = active.length > 0 && active.every((p: any) => !!p.acceptedAt);

        if (allAccepted && refreshed.status !== DispatchStatus.ACCEPTED) {
            await this.prisma.orderDispatch.update({
                where: {id: dispatchId},
                data: {
                    status: DispatchStatus.ACCEPTED,
                    acceptedAllAt: new Date(),
                },
            });

            await this.prisma.order.update({
                where: {id: refreshed.orderId},
                data: {status: OrderStatus.ACCEPTED},
            });
        }

        const remark = typeof payload === 'string' ? payload : payload?.remark;

        await this.logOrderAction(userId, refreshed.orderId, 'ACCEPT_DISPATCH', {
            dispatchId,
            remark: remark ?? null,
        });

        if (allAccepted) {
            try {
                await this.miniSubscribeMessageService.pushOrderProgressMessage(
                    Number(refreshed.orderId),
                    '订单已接单，服务即将开始',
                    '服务中',
                );
            } catch (e: any) {
                console.error('[notify][mini-order-progress][accept-dispatch] failed', e?.message || e);
            }
        }

        return this.getDispatchWithParticipants(dispatchId);
    }

    /** -----------------------------
     * 陪玩拒单（待接单阶段）
     * ToDo 暂不支持拒单，拒单需调整派单逻辑
     * - 必填拒单原因
     * - participant 标记 rejectedAt + rejectReason，并置 isActive=false 进入历史
     * -----------------------------*/
    async rejectDispatch(dispatchId: number, userId: number, reason: string) {
        dispatchId = Number(dispatchId);
        userId = Number(userId);
        reason = String(reason ?? '').trim();

        if (!dispatchId) throw new BadRequestException('dispatchId 必填');
        if (!userId) throw new BadRequestException('未登录或无权限操作');
        if (!reason) throw new BadRequestException('reason 必填');

        const dispatch = await this.prisma.orderDispatch.findUnique({
            where: {id: dispatchId},
            include: {order: true, participants: true},
        });
        if (!dispatch) throw new NotFoundException('派单批次不存在');

        if (dispatch.status !== DispatchStatus.WAIT_ACCEPT) {
            throw new BadRequestException('当前派单状态不可拒单');
        }

        const participant = dispatch.participants.find((p: any) => Number(p.userId) === userId && p.isActive !== false);
        if (!participant) throw new BadRequestException('不在本轮派单参与者中');
        if (participant.acceptedAt) throw new BadRequestException('已接单，不能拒单');
        if (participant.rejectedAt) throw new BadRequestException('已拒单，无需重复操作');

        const now = new Date();

        await this.prisma.orderParticipant.update({
            where: {id: participant.id},
            data: {
                rejectedAt: now,
                rejectReason: reason,
                isActive: false,
            } as any,
        });

        // 拒单后保持空闲
        await this.prisma.user.update({
            where: {id: userId},
            data: {workStatus: PlayerWorkStatus.IDLE as any},
        });

        await this.logOrderAction(userId, dispatch.orderId, 'REJECT_DISPATCH', {
            dispatchId,
            reason,
        });

        return this.getDispatchWithParticipants(dispatchId);
    }

    /** -----------------------------
     * 我的服务记录 / 工作台
     * 我的服务记录（服务者端查看自己参与的派单批次）
     * mode: 'WORKBENCH' -> 工作台：只看当前轮 + 自己是有效参与者
     * mode: 'HISTORY'   -> 接单记录：包含拒单/被替换等历史（只要参与过即可）
     * -----------------------------*/
    async listMyDispatches(params: {
        userId: number;
        page: number;
        limit: number;
        status?: string;
        mode?: 'WORKBENCH' | 'HISTORY';
    }) {
        const userId = Number(params.userId);
        const page = Math.max(1, Number(params.page ?? 1));
        const limit = Math.min(100, Math.max(1, Number(params.limit ?? 20)));
        const skip = (page - 1) * limit;

        if (!userId) throw new BadRequestException('userId 缺失');

        const mode = (params.mode ?? 'HISTORY') as 'WORKBENCH' | 'HISTORY';

        const where: any = {};

        if (mode === 'WORKBENCH') {
            // ✅ 工作台：只查“派给我的当前轮”，要求我在本轮仍有效参与（isActive=true 且未拒单）
            where.order = {currentDispatchId: undefined}; // 占位，下面用 AND 写更清晰
            where.AND = [
                {
                    participants: {
                        some: {
                            userId,
                            isActive: true,
                            rejectedAt: null,
                        },
                    },
                },
                // ✅ 当前轮：只能是订单 currentDispatchId 指向的那条 dispatch
                {
                    currentForOrders: {
                        some: {
                            id: {gt: 0}, // 只要存在 currentForOrders 即可
                        },
                    },
                },
            ];
        } else {
            // ✅ 历史：只要参与过（包含拒单/被替换）
            where.participants = {some: {userId}};
        }

        if (params.status) where.status = params.status as any;

        const [data, total] = await Promise.all([
            this.prisma.orderDispatch.findMany({
                where,
                skip,
                take: limit,
                orderBy: {id: 'desc'},
                include: {
                    order: {
                        include: {
                            project: true,
                            dispatcher: {select: {id: true, name: true, phone: true}},
                        },
                    },

                    // ✅ 关键修复：participants 不再过滤 userId=当前陪玩
                    // - WORKBENCH：返回本轮所有有效参与者（isActive=true 且未拒单），前端才能看到“另一人”
                    // - HISTORY：返回本轮所有参与者（含拒单/被替换），前端才能展示“拒单记录”
                    participants:
                        mode === 'WORKBENCH'
                            ? {
                                where: {isActive: true, rejectedAt: null},
                                include: {user: {select: {id: true, name: true, phone: true}}},
                            }
                            : {
                                include: {user: {select: {id: true, name: true, phone: true}}},
                            },
                },
            }),
            this.prisma.orderDispatch.count({where}),
        ]);

        return {data, total, page, limit, totalPages: Math.ceil(total / limit)};
    }

    /** -----------------------------
     * 陪玩-我的工作台
     * -----------------------------*/
    async getMyWorkbenchStats(userId: number) {
        userId = Number(userId);
        if (!userId) throw new BadRequestException('未登录或无权限操作');

        const now = new Date();

        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

        const startMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        const endMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        // ✅ 1) 今日/月 接单次数：存单+结单都算（每轮一次）
        const dispatchParticipantWhere: any = {
            participants: {
                some: {
                    userId,
                    isActive: true,
                    rejectedAt: null,
                },
            },
        };

        const [todayArchiveCount, todayCompleteCount, monthArchiveCount, monthCompleteCount] =
            await Promise.all([
                this.prisma.orderDispatch.count({
                    where: {...dispatchParticipantWhere, archivedAt: {gte: startToday, lte: endToday}},
                }),
                this.prisma.orderDispatch.count({
                    where: {...dispatchParticipantWhere, completedAt: {gte: startToday, lte: endToday}},
                }),
                this.prisma.orderDispatch.count({
                    where: {...dispatchParticipantWhere, archivedAt: {gte: startMonth, lte: endMonth}},
                }),
                this.prisma.orderDispatch.count({
                    where: {...dispatchParticipantWhere, completedAt: {gte: startMonth, lte: endMonth}},
                }),
            ]);

        const todayCount = Number(todayArchiveCount) + Number(todayCompleteCount);
        const monthCount = Number(monthArchiveCount) + Number(monthCompleteCount);

        // ✅ 2) 收入净额：IN - OUT（包含冻结），排除 REVERSED
        // 说明：
        // - 正收益：direction=IN（通常 FROZEN/AVAILABLE 都算）
        // - 炸单负收益：你钱包实现会写 direction=OUT（AVAILABLE），这里会被抵扣
        const incomeBizTypes = [
            'SETTLEMENT_EARNING',       // 兼容旧
            'SETTLEMENT_EARNING_BASE',  // 基础收益
            'SETTLEMENT_EARNING_CARRY', // 补偿收益
            'SETTLEMENT_EARNING_CS',    // 客服分红
            'SETTLEMENT_BOMB_LOSS',     // 炸单损耗（OUT）
        ];

        const baseWhere: any = {
            userId,
            bizType: {in: incomeBizTypes},
            status: {not: 'REVERSED'},
        };

        const [todayAgg, monthAgg] = await Promise.all([
            this.prisma.walletTransaction.aggregate({
                where: {...baseWhere, createdAt: {gte: startToday, lte: endToday}},
                _sum: {amount: true},
            }),
            this.prisma.walletTransaction.aggregate({
                where: {...baseWhere, createdAt: {gte: startMonth, lte: endMonth}},
                _sum: {amount: true},
            }),
        ]);

        // ❗aggregate 无法按 direction 分组，所以最小改动：再查一次 OUT 的 sum（两次 aggregate）
        const [todayOutAgg, monthOutAgg] = await Promise.all([
            this.prisma.walletTransaction.aggregate({
                where: {
                    ...baseWhere,
                    direction: 'OUT',
                    createdAt: {gte: startToday, lte: endToday},
                },
                _sum: {amount: true},
            }),
            this.prisma.walletTransaction.aggregate({
                where: {
                    ...baseWhere,
                    direction: 'OUT',
                    createdAt: {gte: startMonth, lte: endMonth},
                },
                _sum: {amount: true},
            }),
        ]);

        const todayTotal = Number(todayAgg?._sum?.amount ?? 0);
        const monthTotal = Number(monthAgg?._sum?.amount ?? 0);

        const todayOut = Number(todayOutAgg?._sum?.amount ?? 0);
        const monthOut = Number(monthOutAgg?._sum?.amount ?? 0);

        // ✅ 净额 = 总额 - OUT（因为 amount 始终为正数，OUT 用来表达扣款）
        const todayIncome = todayTotal - todayOut;
        const monthIncome = monthTotal - monthOut;

        return {todayCount, todayIncome, monthCount, monthIncome};
    }

    /** ====== 公共方法区（后续应提到utils）========== */
    /** -----------------------------
     * 补收方法？
     * -----------------------------*/
    private async applyPaidAmountUpdateInTx(tx: any, order: any, paidAmount: number, operatorId: number, remark?: string, confirmPaid?: any) {
        if (!Number.isFinite(paidAmount) || paidAmount < 0) {
            throw new BadRequestException('paidAmount 非法');
        }

        // confirmPaid 默认 true（补收一般=钱已收）
        const confirmPaidBool = this.parseBool(confirmPaid, true);

        // 赠送单不允许补收
        if ((order as any).isGifted) throw new BadRequestException('赠送单不允许补收实付金额');

        // 已退款订单不允许补收
        if (order.status === OrderStatus.REFUNDED) throw new BadRequestException('已退款订单不允许补收实付金额');

        // 仅小时单允许补收（你要的是“客服确认结单弹窗里录补收”，目前只对小时单）
        const billingMode: BillingMode | undefined = this.getBillingModeFromOrder(order);
        if (billingMode !== BillingMode.HOURLY) throw new BadRequestException('仅小时单允许补收实付金额');

        // 只允许增加
        const old = Number(order.paidAmount ?? 0);
        if (paidAmount < old) throw new BadRequestException('实付金额仅允许增加（超时补收），不允许减少');

        // 是否标记收款（仅在原来未收款时）
        const shouldMarkPaid = confirmPaidBool && (order as any).isPaid !== true;
        const now = new Date();

        // 金额没变：只在 shouldMarkPaid 时标记收款
        if (paidAmount === old) {
            if (!shouldMarkPaid) return {changed: false};

            await tx.order.update({
                where: {id: order.id},
                data: {isPaid: true, paymentTime: now},
            });

            await this.writeUserLog(tx, {
                userId: operatorId,
                action: 'MARK_PAID_BY_CONFIRM_COMPLETE',
                targetType: 'ORDER',
                targetId: order.id,
                oldData: {
                    paidAmount: old,
                    isPaid: (order as any).isPaid ?? null,
                    paymentTime: order.paymentTime ?? null
                } as any,
                newData: {paidAmount: old, isPaid: true, paymentTime: now} as any,
                remark: remark || `确认结单时确认收款（金额未变）：${old}`,
            });

            return {changed: false};
        }

        // 金额变化：更新 paidAmount，并可顺带确认收款
        await tx.order.update({
            where: {id: order.id},
            data: {
                paidAmount,
                ...(shouldMarkPaid ? {isPaid: true, paymentTime: now} : {}),
            },
        });

        await this.writeUserLog(tx, {
            userId: operatorId,
            action: 'UPDATE_PAID_AMOUNT_BY_CONFIRM_COMPLETE',
            targetType: 'ORDER',
            targetId: order.id,
            oldData: {
                paidAmount: old,
                isPaid: (order as any).isPaid ?? false,
                paymentTime: order.paymentTime ?? null
            } as any,
            newData: {
                paidAmount,
                ...(shouldMarkPaid ? {isPaid: true, paymentTime: now} : {}),
            } as any,
            remark: remark || `确认结单时补收实付：${old} → ${paidAmount}`,
        });

        return {changed: true};
    }


    /** -----------------------------
     * 生成订单序列号：YYYYMMDD-0001 Todo 订单编号得改，这个规则有点丑
     * v0.1：用 DB 查询当日最大序号后 +1
     * -----------------------------*/

    private async generateOrderSerial(): Promise<string> {
        const VERSION = 'V01';

        // 1) 时间片：分钟级（你也可以改成秒级 Date.now() / 1000）
        //    转 base36 后不明显是年月日，但大体递增，利于排序/排查
        const minuteBucket = Math.floor(Date.now() / 60000);
        const timePart = minuteBucket.toString(36).toUpperCase(); // e.g. "MZ9K3A"

        // 2) 随机尾巴：4-6 位（base36），强烈降低并发撞号概率
        const len = randomInt(4, 7); // 4..6
        const max = 36 ** len;
        const rand = randomInt(0, max);
        const randPart = rand.toString(36).toUpperCase().padStart(len, '0');

        // 3) 拼接：无 "-"
        const candidate = `${VERSION}${timePart}${randPart}`;

        // 4) 可选：做一次轻量去重（极小概率撞号时重试）
        //    如果你有 autoSerial 唯一索引，下面逻辑更保险（没有也能用）
        const exists = await this.prisma.order.findFirst({
            where: { autoSerial: candidate },
            select: { id: true },
        });

        if (!exists) return candidate;

    // 极小概率：再来一次（不搞循环，保持简单；你也可以 while 重试 3 次）
    const len2 = randomInt(4, 7);
    const max2 = 36 ** len2;
    const rand2 = randomInt(0, max2);
    const randPart2 = rand2.toString(36).toUpperCase().padStart(len2, '0');
    return `${VERSION}${timePart}${randPart2}`;
    }


/** -----------------------------
     * 审计日志（UserLog）
     * -----------------------------*/
    private async logOrderAction(
        operatorId: number,
        orderId: number,
        action: string,
        newData: any,
        tx?: any,
        remark?: string,
    ) {
        const uid = Number(operatorId);
        if (!uid) {
            throw new BadRequestException('缺少操作人身份（operatorId），请重新登录后重试');
        }

        const db = tx ?? this.prisma;

        await db.userLog.create({
            data: {
                userId: operatorId,
                action,
                targetType: 'ORDER',
                targetId: orderId,
                oldData: null,
                newData,
                remark,
            },
        });
    }

    /** -----------------------------
     * userLog 写入封装：减少重复 & 后续易统一字段
     * todo  需确认是否跟以上审计日志重叠
     * -----------------------------*/
    private async writeUserLog(
        tx: any,
        data: {
            userId: number;
            action: string;
            targetType: string;
            targetId: number;
            oldData?: any;
            newData?: any;
            remark?: string;
        },
    ) {
        // 防御：operatorId=0/null 时不写
        if (!data?.userId) return;

        await tx.userLog.create({
            data: {
                userId: data.userId,
                action: data.action,
                targetType: data.targetType,
                targetId: data.targetId,
                oldData: data.oldData ?? null,
                newData: data.newData ?? null,
                remark: data.remark ?? null,
            } as any,
        });
    }

    /** -----------------------------
     * 订单轮次 dispatch 结算互斥抢占
     * - 只能从 ACCEPTED -> SETTLING
     * - 抢占成功：当前请求成为“唯一结算者”
     * - 抢占失败：说明另一个请求已经在处理/处理完成
     * -----------------------------*/
    async lockDispatchForSettlementOrThrow(dispatchId: number, tx: any, allowWaitAccept = false) {
        const locked = await tx.orderDispatch.updateMany({
            where: {
                id: dispatchId,
                status: allowWaitAccept
                    ? { in: [DispatchStatus.WAIT_ACCEPT, DispatchStatus.ACCEPTED] }
                    : DispatchStatus.ACCEPTED,
            },
            data: {status: DispatchStatus.SETTLING},
        });

        if (locked.count === 0) {
            // ✅ 抢占失败：要么已结算/已存单，要么正在处理中
            throw new BadRequestException('该派单正在结算中或已处理，请刷新后重试');
        }

    }

    /** -----------------------------
     * progress 写入（tx）
     * - Todo 需明确该方法的使用，以及影响范围
     * -----------------------------*/
    private async applyProgressAndDeduct(
        tx: any,
        dispatch: any,
        dto: { progresses?: Array<{ userId: number; progressBaseWan?: number }>; deductMinutesOption?: string },
    ) {
        // ✅ 只处理 progress（保底单）；小时单扣时由 computeAndPersistBillingHours 统一计算并落库
        const progresses = Array.isArray(dto?.progresses) ? dto.progresses : [];
        if (progresses.length === 0) return;

        const parts = Array.isArray(dispatch?.participants) ? dispatch.participants : [];
        const activeParts = parts.filter((p: any) => p?.isActive && !p?.rejectedAt);
        if (activeParts.length === 0) return;

        const normalize = (v: any) => {
            if (v === null || v === undefined) return null;
            const n = Number(v);
            if (!Number.isFinite(n)) return null;
            return roundMix1(n); // ✅ 允许负数
        };

        // ✅ 情况1：只传 1 条（前端未拆分）=> 按人数平均拆分写入每个 active participant
        if (progresses.length === 1 && activeParts.length > 1) {
            const total = normalize(progresses[0]?.progressBaseWan);
            if (total === null) return;

            const n = activeParts.length;
            const avg = roundMix1(total / n);

            // 尾差给最后一个（保证 sum 精确等于 total）
            for (let i = 0; i < n; i++) {
                const part = activeParts[i];
                let v = avg;
                if (i === n - 1) {
                    const sumBeforeLast = roundMix1(avg * (n - 1));
                    v = roundMix1(total - sumBeforeLast);
                }

                await tx.orderParticipant.update({
                    where: {id: part.id},
                    data: {progressBaseWan: v},
                });
            }
            return;
        }

        // ✅ 情况2：传多条（前端已拆分 or 按人录入）=> 精确写入
        const map = new Map<number, number | null>();
        for (const p of progresses) {
            const uid = Number(p?.userId);
            if (!Number.isFinite(uid) || uid <= 0) continue;
            map.set(uid, normalize(p?.progressBaseWan));
        }

        for (const part of activeParts) {
            const uid = Number(part?.userId);
            if (!Number.isFinite(uid) || uid <= 0) continue;
            if (!map.has(uid)) continue;

            await tx.orderParticipant.update({
                where: {id: part.id},
                data: {progressBaseWan: map.get(uid)},
            });
        }
    }


    /** -----------------------------
     * 小时单：计算并落库 billableMinutes / billableHours
     * - 计时：acceptedAllAt -> archivedAt / completedAt（以 action 来决定终点）
     * - 扣时：deductMinutesValue（10/20/.../60）
     * -----------------------------*/
    private async computeAndPersistBillingHours(
        tx: any,
        dispatch: any,
        action: 'ARCHIVE' | 'COMPLETE',
        endTime: Date,
        deductMinutesOption?: string,
    ) {
        const billingMode = dispatch?.order?.project?.billingMode;
        if (billingMode !== BillingMode.HOURLY) return null;

        if (!dispatch.acceptedAllAt) {
            throw new BadRequestException('小时单缺少全员接单时间，无法计算时长');
        }

        const deductValue = this.mapDeductMinutesValue(deductMinutesOption);
        const rawMinutes = Math.max(
            0,
            Math.floor((endTime.getTime() - dispatch.acceptedAllAt.getTime()) / 60000),
        );

        const effectiveMinutes = Math.max(0, rawMinutes - deductValue);
        const billableHours = this.minutesToBillableHours(effectiveMinutes);

        await tx.orderDispatch.update({
            where: {id: dispatch.id},
            data: {
                deductMinutes: deductMinutesOption as any,
                deductMinutesValue: deductValue || null,
                billableMinutes: effectiveMinutes,
                billableHours,
            },
        });

        return {action, rawMinutes, deductValue, effectiveMinutes, billableHours};
    }

    /**
     * 生成结算明细（核心）
     *
     * 结算口径（按最新规则）：
     * - 单次派单 + 本次为结单：直接按订单实付金额 paidAmount 结算全量
     * - 多次派单：使用 computeDispatchRatio（保底进度/结单结剩余等）计算本轮 ratio
     * - 分配方式：优先按 participant.contributionAmount 权重；否则均分
     * - 到手收益 multiplier 优先级：
     *   1) 订单固定抽成（平台抽成）：each * (1 - 抽成)
     *   2) 项目固定抽成（平台抽成）：each * (1 - 抽成)
     *   3) 陪玩分红比例（到手比例）：each * 分红
     *  Todo 最大问题在这里，禁止每轮生成结算明细，最后统一结算
     * ✅ 为某一轮派单生成结算明细（存单 / 结单都会走）
     *
     * 设计要点：
     * 1) ❌ 不在内部开启 transaction
     *    - 外层（archiveDispatch / completeDispatch）已经在 $transaction 中
     *    - 避免 Prisma 嵌套事务失效导致“部分提交”
     *
     * 2) ✅ settlementBatchId：本轮结算唯一批次号
     *    - 用于追溯 / 对账 / 未来微信打款
     *
     * 3) ✅ 使用 upsert + schema @@unique
     *    - 防止并发 / 重试 / 一个结单一个存单导致重复结算
     *
     * 4) ✅ settlement + 钱包冻结必须在同一个 tx 中
     */
    async createSettlementsForDispatch(
        params: {
            orderId: number;
            dispatchId: number;
            mode: 'ARCHIVE' | 'COMPLETE';
            settlementBatchId: string; // ✅ 结算批次号
            allowWalletSync?: boolean; // ✅ 可选：仅重算结算时可关闭钱包同步（默认 true，保持旧行为）
        },
        tx: any, // ✅ 外层事务
    ) {
        const {orderId, dispatchId, mode, settlementBatchId} = params;
        const allowWalletSync = params.allowWalletSync !== false; // 默认 true


        // ===========================
        // 客服分红比例（不落库，纯规则）
        // ===========================
        const CUSTOMER_SERVICE_SHARE_RATE = 0.01;

        // ---------- 工具函数 ----------
        const isSet = (v: any) => v !== null && v !== undefined; // ✅ 0 也算已设置
        const normalizeToRatio = (v: any, fallback: number) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            return n > 1 ? n / 100 : n;
        };

        // 1️⃣ 读取订单 & 派单（必须用 tx）
        const order = await tx.order.findUnique({
            where: {id: orderId},
            include: {
                project: true,
                dispatcher: {
                    select: {
                        id: true,
                        name: true,
                        userType: true,
                    },
                },
                initialDispatcher: {
                    select: {
                        id: true,
                        name: true,
                        userType: true,
                    },
                },
            },
        });
        if (!order) throw new NotFoundException('订单不存在');

        const dispatch = await tx.orderDispatch.findUnique({
            where: {id: dispatchId},
            include: {participants: true},
        });
        if (!dispatch) throw new NotFoundException('派单批次不存在');

        // // 2️⃣ 本轮参与者（只结算 active 且未拒单的，避免历史重复结算/拒单参与分摊）
        // const participants = (dispatch.participants || []).filter(
        //     (p: any) => p?.isActive && !p?.rejectedAt,
        // );
        // if (participants.length === 0) return true;

        // 2️⃣ 本轮参与者
        // - ✅ 进行中（WAIT_ACCEPT/ACCEPTED/SETTLING 等）：只取 isActive=true，避免把“被替换的历史参与者”重复计入
        // - ✅ 已完成（COMPLETED/ARCHIVED）：参与者已被置为历史（isActive=false），但仍必须满足 acceptedAt!=null，
        //      避免把“从未接单、后续被客服换人”的历史参与者误计入结算
        const dispatchStatus: any = (dispatch as any).status;

        const isFinalized =
            dispatchStatus === (DispatchStatus as any).COMPLETED ||
            dispatchStatus === (DispatchStatus as any).ARCHIVED;

        const participants = (dispatch.participants || []).filter((p: any) => {
            if (p?.rejectedAt) return false;
            return isFinalized ? !!p?.acceptedAt : !!p?.isActive;
        });

        if (participants.length === 0) return true;

        // 3️⃣ 本轮基础结算类型（体验单 / 正价单）
        const baseSettlementType = order.type === OrderType.EXPERIENCE ? 'EXPERIENCE' : 'REGULAR';

        const settlementUserIds = Array.from(new Set([
            ...participants.map((p: any) => Number(p.userId || 0)),
            Number(order?.dispatcherId || 0),
            Number(order?.initialDispatcherId || 0),
        ].filter((id) => id > 0)));
        const settlementFreezeInfoByUser = await this.buildSettlementFreezeInfoByUserTx(
            tx,
            {
                ...order,
                projectSnapshot: { type: order.type },
                dispatches: [{ status: 'COMPLETED', completedAt: new Date() }],
            },
            settlementUserIds,
        );
        const getUnlockAt = (userId: number) => (
            settlementFreezeInfoByUser.get(Number(userId)) || computeSettlementFreezeTime({
                order: {
                    ...order,
                    projectSnapshot: { type: order.type },
                    dispatches: [{ status: 'COMPLETED', completedAt: new Date() }],
                },
            })
        ).freezeEndAt;

        // 4️⃣ 分摊规则（原有逻辑兼容）
        const ratioMap = this.buildProgressRatioMap(participants);

        const dispatchCount = await tx.orderDispatch.count({
            where: {orderId},
        });

        // ---------- 4.1) 结算瞬间快照：抽成规则输入 ----------
        const orderCutRaw = isSet(order.customClubRate) ? order.customClubRate : null;

        const snap: any = order.projectSnapshot || {};
        const projectCutRaw = isSet(snap.clubRate)
            ? snap.clubRate
            : isSet(order.project?.clubRate)
                ? order.project.clubRate
                : null;

        // ---------- 4.2) 员工评级抽成快照（仅当订单/项目都未设置抽成时才需要） ----------
        let staffCutMap: Map<number, number> | undefined;

        if (!isSet(orderCutRaw) && !isSet(projectCutRaw)) {
            const userIds = participants.map((p: any) => p.userId);
            const users = await tx.user.findMany({
                where: {id: {in: userIds}},
                select: {id: true, staffRating: {select: {rate: true}}},
            });

            staffCutMap = new Map<number, number>();
            for (const u of users) {
                staffCutMap.set(u.id, Number(u.staffRating?.rate ?? 0));
            }
        }

        const multiplierPriority = isSet(orderCutRaw)
            ? 'ORDER_CUT'
            : isSet(projectCutRaw)
                ? 'PROJECT_CUT'
                : 'PLAYER_CUT';

        // ===========================
        // ✅ 4.3 HOURLY 不走保底口径；GUARANTEED 才走 progress→gross/carry
        // ===========================
        const billingMode =
            (order.projectSnapshot as any)?.billingMode ?? (order.project as any)?.billingMode;

        const isHourly = billingMode === BillingMode.HOURLY;

        // 结算金额：默认取 settlementBaseAmount；历史老单兜底到 paidAmount / receivableAmount / originalAmount
        const settlementBaseAmount = this.getSettlementBaseAmountFromOrder(order);
        if (!Number.isFinite(settlementBaseAmount) || settlementBaseAmount <= 0) {
            throw new BadRequestException('订单结算基数非法');
        }

        // 现金实收：仍保留用于财务对账 / 现金核对
        const paidAmount = Number((order as any).paidAmount ?? 0);
        if (!Number.isFinite(paidAmount) || paidAmount < 0) {
            throw new BadRequestException('订单 paidAmount 非法');
        }

        // ✅ 本轮 progress 汇总（抗“只填自己/重复填同一个值”）
        // ✅ 本轮 progress 汇总（口径统一：progressBaseWan 永远是“每个参与者各自的进度(万)”）
        // - 因此前端传 150/150 时，本轮总进度必须是 300
        // - 允许负数（炸单）
        let hasAnyProgressInput = false;
        let dispatchProgressWan = 0;

        const filledProgress: number[] = [];
        for (const p of participants) {
            const v = (p as any).progressBaseWan;
            if (v === null || v === undefined) continue;
            const n = Number(v);
            if (!Number.isFinite(n)) continue;
            filledProgress.push(roundMix1(n));
        }

        if (filledProgress.length > 0) {
            hasAnyProgressInput = true;
            dispatchProgressWan = roundMix1(filledProgress.reduce((s, x) => s + x, 0));
        }

        // ✅ COMPLETE 自动补齐剩余保底：小时单跳过（没有保底概念）
        if (mode === 'COMPLETE' && !hasAnyProgressInput && !isHourly) {
            const allDispatches = await tx.orderDispatch.findMany({
                where: {orderId},
                select: {participants: {select: {progressBaseWan: true}}},
            });

            let sumProgressWan = 0;
            for (const d of allDispatches) {
                for (const part of d.participants || []) {
                    const v = (part as any).progressBaseWan;
                    if (v === null || v === undefined) continue;
                    const n = Number(v);
                    if (!Number.isFinite(n)) continue;
                    sumProgressWan += n; // ✅ 允许负数
                }
            }

            const baseWan = Number((order as any).baseAmountWan ?? 0);
            if (!Number.isFinite(baseWan) || baseWan <= 0) {
                throw new BadRequestException('订单 baseAmountWan 非法-02');
            }

            const remainingWan = roundMix1(baseWan - sumProgressWan);
            dispatchProgressWan = remainingWan > 0 ? remainingWan : 0;
            hasAnyProgressInput = true;
        }

        // ✅ gross/carry 相关变量：必须都有默认值（避免 undefined）
        let rateWanPerYuan: number | null = null;
        let grossRmb: number | null = null;

        let consumedPaidPool = 0;
        let carryDebt = 0;
        let carryPaid = 0;
        let carryRemaining = 0;
        let remainingPaidPool = 0;

        let repayRmb = 0;
        let normalGrossRmb = 0;
        let excessNormalRmb = 0;

        if (!isHourly && hasAnyProgressInput) {
            const baseAmountWan = Number((order as any).baseAmountWan ?? 0);
            if (!Number.isFinite(baseAmountWan) || baseAmountWan <= 0) {
                throw new BadRequestException('订单 baseAmountWan 非法-01');
            }

            rateWanPerYuan = roundMix1(baseAmountWan / settlementBaseAmount);
            grossRmb = roundMix1(dispatchProgressWan / rateWanPerYuan);

            // ✅ carry/pool 聚合
            const allForOrder = await tx.orderSettlement.findMany({
                where: {orderId},
                select: {settlementType: true, calculatedEarnings: true},
            });

            for (const s of allForOrder) {
                const cal = Number((s as any).calculatedEarnings ?? 0);
                if (!Number.isFinite(cal) || cal === 0) continue;

                if ((s as any).settlementType === baseSettlementType) {
                    if (cal > 0) consumedPaidPool += cal;
                    if (cal < 0) carryDebt += -cal;
                }

                if ((s as any).settlementType === 'CARRY_COMPENSATION') {
                    if (cal > 0) carryPaid += cal;
                }
            }

            consumedPaidPool = roundMix1(consumedPaidPool);
            carryDebt = roundMix1(carryDebt);
            carryPaid = roundMix1(carryPaid);

            carryRemaining = Math.max(0, roundMix1(carryDebt - carryPaid));
            remainingPaidPool = Math.max(0, roundMix1(settlementBaseAmount - consumedPaidPool));

            // ✅ gross 拆分：repay + normalGross
            if (grossRmb < 0) {
                repayRmb = 0;
                normalGrossRmb = grossRmb; // ✅ 负数
                excessNormalRmb = 0;
            } else if (grossRmb > 0) {
                repayRmb = Math.min(grossRmb, carryRemaining);

                const candidate = roundMix1(grossRmb - repayRmb);
                normalGrossRmb = Math.min(candidate, remainingPaidPool);

                excessNormalRmb = roundMix1(candidate - normalGrossRmb);
            } else {
                repayRmb = 0;
                normalGrossRmb = 0;
                excessNormalRmb = 0;
            }
        } else {
            // ✅ 小时单：强制走旧口径
            grossRmb = null;
            rateWanPerYuan = null;
        }

        // ===========================
        // 5️⃣ 逐个陪玩生成基础结算（幂等）
        // - grossRmb!=null：按 normalGrossRmb 均摊（可负）
        // - grossRmb==null：走旧口径 calcPlayerEarning（小时单）
        // ===========================

        const userIds = participants.map((p: any) => p.userId);
        const existingBase = await tx.orderSettlement.findMany({
            where: {
                dispatchId,
                settlementType: baseSettlementType,
                userId: {in: userIds},
            },
            select: {id: true, userId: true},
        });
        const baseMap = new Map<number, any>();
        for (const e of existingBase) baseMap.set(e.userId, e);

        await Promise.all(
            participants.map(async (p: any, idx: number) => {
                const userId = p.userId;

                let calculated: number;

                if (grossRmb !== null) {
                    const avg = roundMix1(normalGrossRmb / participants.length);
                    calculated = avg;

                    if (idx === participants.length - 1) {
                        const sumBeforeLast = roundMix1(avg * (participants.length - 1));
                        calculated = roundMix1(normalGrossRmb - sumBeforeLast);
                    }
                } else {
                    const ratio = ratioMap.get(p.id) ?? 1;
                    calculated = this.calcPlayerEarning({
                        order,
                        participantsCount: participants.length,
                        ratio,
                        _dbg: {orderId, dispatchId, userId},
                    });
                }

                // ✅ 炸单（gross<0）：不抽成
                let multiplier = 1;
                if (!(grossRmb !== null && grossRmb < 0)) {
                    multiplier = this.resolveMultiplier(order, p, {
                        orderCutRaw,
                        projectCutRaw,
                        staffCutMap,
                    });
                }

                const calculated1 = roundMix1(calculated);
                const final1 = roundMix1(calculated1 * multiplier);
                const manualAdj1 = roundMix1(final1 - calculated1);
                const club1 = roundMix1(calculated1 - final1);

                const found = baseMap.get(userId);

                let settlementId: number;
                let settlementFinal: number;

                if (!found) {
                    const created = await tx.orderSettlement.create({
                        data: {
                            orderId,
                            dispatchId,
                            userId,
                            settlementType: baseSettlementType,
                            settlementBatchId,

                            calculatedEarnings: calculated1,
                            manualAdjustment: manualAdj1,
                            finalEarnings: final1,
                            clubEarnings: club1,

                            csEarnings: null,
                            inviteEarnings: null,
                            paymentStatus: PaymentStatus.UNPAID,
                        },
                        select: {id: true, finalEarnings: true},
                    });

                    settlementId = created.id;
                    settlementFinal = Number(created.finalEarnings ?? 0) as any;
                } else {
                    const updated = await tx.orderSettlement.update({
                        where: {id: found.id},
                        data: {
                            settlementBatchId,

                            calculatedEarnings: calculated1,
                            manualAdjustment: manualAdj1,
                            finalEarnings: final1,
                            clubEarnings: club1,
                        },
                        select: {id: true, finalEarnings: true},
                    });

                    settlementId = updated.id;
                    settlementFinal = Number(updated.finalEarnings ?? 0) as any;
                }

                // ✅ 钱包同步：负收益会写 direction=OUT（你贴的钱包方法已支持）
                if (allowWalletSync) {
                    await this.wallet.syncSettlementEarningByFinalEarnings(
                        {
                            userId,
                            finalEarnings: settlementFinal,
                            unlockAt: getUnlockAt(userId),
                            sourceType: 'ORDER_SETTLEMENT',
                            bizType:
                                grossRmb !== null && grossRmb < 0
                                    ? WalletBizType.SETTLEMENT_BOMB_LOSS
                                    : WalletBizType.SETTLEMENT_EARNING_BASE,
                            sourceId: settlementId,
                            orderId,
                            dispatchId,
                            settlementId,
                        },
                        tx,
                    );
                }
            }),
        );

        // ===========================
        // 5.9 炸单池补偿（仅非小时单 + grossRmb>0 + repayRmb>0）
        // ===========================
        if (grossRmb !== null && repayRmb > 0) {
            const n = participants.length;
            const avg = roundMix1(repayRmb / n);

            const existingComp = await tx.orderSettlement.findMany({
                where: {
                    dispatchId,
                    settlementType: 'CARRY_COMPENSATION',
                    userId: {in: userIds},
                },
                select: {id: true, userId: true},
            });
            const compMap = new Map<number, { id: number }>();
            for (const e of existingComp) compMap.set(e.userId, e);

            for (let idx = 0; idx < n; idx++) {
                const p = participants[idx];
                const userId = (p as any).userId;

                let calculated = avg;
                if (idx === n - 1) {
                    const sumBeforeLast = roundMix1(avg * (n - 1));
                    calculated = roundMix1(repayRmb - sumBeforeLast);
                }

                const calculated1 = roundMix1(calculated);
                const final1 = calculated1;

                const found = compMap.get(userId);

                let settlementId: number;
                let settlementFinal: number;

                if (!found) {
                    const created = await tx.orderSettlement.create({
                        data: {
                            orderId,
                            dispatchId,
                            userId,
                            settlementType: 'CARRY_COMPENSATION',
                            settlementBatchId,

                            calculatedEarnings: calculated1,
                            manualAdjustment: 0,
                            finalEarnings: final1,
                            clubEarnings: 0,
                            contributionBaseAmount: calculated1,
                            grossPerformanceAmount: calculated1,
                            netIncomeAmount: final1,

                            csEarnings: null,
                            inviteEarnings: null,
                            paymentStatus: PaymentStatus.UNPAID,
                        },
                        select: {id: true, finalEarnings: true},
                    });

                    settlementId = created.id;
                    settlementFinal = Number(created.finalEarnings ?? 0) as any;
                } else {
                    const updated = await tx.orderSettlement.update({
                        where: {id: found.id},
                        data: {
                            settlementBatchId,
                            calculatedEarnings: calculated1,
                            manualAdjustment: 0,
                            finalEarnings: final1,
                            clubEarnings: 0,
                            contributionBaseAmount: calculated1,
                            grossPerformanceAmount: calculated1,
                            netIncomeAmount: final1,
                        },
                        select: {id: true, finalEarnings: true},
                    });

                    settlementId = updated.id;
                    settlementFinal = Number(updated.finalEarnings ?? 0) as any;
                }

                if (allowWalletSync) {
                    await this.wallet.syncSettlementEarningByFinalEarnings(
                        {
                            userId,
                            finalEarnings: settlementFinal,
                            unlockAt: getUnlockAt(userId),
                            sourceType: 'ORDER_SETTLEMENT',
                            bizType: WalletBizType.SETTLEMENT_EARNING_CARRY,
                            sourceId: settlementId,
                            orderId,
                            dispatchId,
                            settlementId,
                        },
                        tx,
                    );
                }
            }
        }

        // ===========================
        // 6️⃣ 客服分红（仅 COMPLETE 写入）
        // ✅ 规则修复：体验单/福袋单不参与客服抽成y
        const orderTypeForCs: any = ((order as any).projectSnapshot as any)?.type ?? ((order as any).project as any)?.type;
        const isCsExcluded =
            orderTypeForCs === OrderType.EXPERIENCE || orderTypeForCs === (OrderType as any).LUCKY_BAG;
        const initialDispatcher = this.resolveInitialDispatcher(order);

        // ===========================
        if (
            !isCsExcluded
            && mode === 'COMPLETE'
            && CUSTOMER_SERVICE_SHARE_RATE > 0
            && initialDispatcher.userId
            && String(initialDispatcher.user?.userType || '') === 'CUSTOMER_SERVICE'
        ) {
            const csAmount = roundMix1(settlementBaseAmount * CUSTOMER_SERVICE_SHARE_RATE);
            if (csAmount > 0) {
                const csFound = await tx.orderSettlement.findUnique({
                    where: {
                        dispatchId_userId_settlementType: {
                            dispatchId,
                            userId: initialDispatcher.userId,
                            settlementType: 'CUSTOMER_SERVICE',
                        },
                    },
                    select: {id: true},
                });

                let csId: number;
                let csFinal: number;

                if (!csFound) {
                    const created = await tx.orderSettlement.create({
                        data: {
                            orderId,
                            dispatchId,
                            userId: initialDispatcher.userId,
                            settlementType: 'CUSTOMER_SERVICE',
                            settlementBatchId,

                            calculatedEarnings: csAmount,
                            manualAdjustment: 0,
                            finalEarnings: csAmount,
                            clubEarnings: 0,
                            csEarnings: null,
                            inviteEarnings: null,
                            paymentStatus: PaymentStatus.UNPAID,
                        },
                        select: {id: true, finalEarnings: true},
                    });
                    csId = created.id;
                    csFinal = Number(created.finalEarnings ?? 0) as any;
                } else {
                    const updated = await tx.orderSettlement.update({
                        where: {id: csFound.id},
                        data: {
                            settlementBatchId,
                            calculatedEarnings: csAmount,
                            manualAdjustment: 0,
                            finalEarnings: csAmount,
                            clubEarnings: 0,
                        },
                        select: {id: true, finalEarnings: true},
                    });
                    csId = updated.id;
                    csFinal = Number(updated.finalEarnings ?? 0) as any;
                }

                if (allowWalletSync) {
                    await this.wallet.syncSettlementEarningByFinalEarnings(
                        {
                            userId: initialDispatcher.userId,
                            finalEarnings: csFinal,
                            unlockAt: getUnlockAt(initialDispatcher.userId),
                            sourceType: 'ORDER_SETTLEMENT',
                            bizType: WalletBizType.SETTLEMENT_EARNING_CS,
                            sourceId: csId,
                            orderId,
                            dispatchId,
                            settlementId: csId,
                        },
                        tx,
                    );
                }
            }
        }

        // ===========================
        // 7️⃣ 聚合回写订单
        // ===========================
        await this.assertPersistedOrderSettlementPayoutWithinBaseTx({
            tx,
            order,
            context: mode === 'COMPLETE' ? '客服结单' : '客服存单',
        });

        const agg = await tx.orderSettlement.aggregate({
            where: {orderId},
            _sum: {finalEarnings: true, clubEarnings: true},
        });

        await tx.order.update({
            where: {id: orderId},
            data: {
                totalPlayerEarnings: roundMix1(Number(agg._sum.finalEarnings ?? 0)),
                clubEarnings: roundMix1(Number(agg._sum.clubEarnings ?? 0)),
            },
        });

        // ===========================
        // 8️⃣ 操作日志（记录关键追溯字段）
        // ===========================
        await this.logOrderAction(
            initialDispatcher.userId || order.dispatcherId,
            orderId,
            mode === 'ARCHIVE' ? 'SETTLE_ARCHIVE' : 'SETTLE_COMPLETE',
            {
                dispatchId,
                settlementBatchId,
                rule: dispatchCount === 1 && mode === 'COMPLETE' ? 'SINGLE_COMPLETE_FULL' : 'RATIO_BY_PROGRESS',
                multiplierPriority,

                orderCut: isSet(orderCutRaw) ? normalizeToRatio(orderCutRaw, 0) : null,
                projectCut: !isSet(orderCutRaw) && isSet(projectCutRaw) ? normalizeToRatio(projectCutRaw, 0) : null,
                staffCutHint: !isSet(orderCutRaw) && !isSet(projectCutRaw) ? 'STAFF_RATING_RATE' : null,

                billingMode,
                rateWanPerYuan,
                dispatchProgressWan: hasAnyProgressInput ? dispatchProgressWan : null,
                grossRmb,

                carryDebt,
                carryPaid,
                carryRemaining,
                repayRmb,
                normalGrossRmb,
                remainingPaidPool,
                excessNormalRmb,
            },
            tx,
        );

        return true;
    }

    /** -----------------------------
     * 分钟 -> 计费小时（的规则）
     * -ToDo 改造结算明细和小时单落库后将废弃
     * - 整数小时正常计
     * - 余分钟：<15=0, 15~45=0.5, >45=1
     * - totalMinutes < 15 => 0
     * -----------------------------*/
    private minutesToBillableHours(totalMinutes: number): number {
        if (totalMinutes < 15) return 0;

        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        let extra = 0;
        if (minutes < 15) extra = 0;
        else if (minutes <= 45) extra = 0.5;
        else extra = 1;

        return hours + extra;
    }

    /** -----------------------------
     * 订单结算中（存在 SETTLING 轮次）禁止某些操作（补收/重算/钱包对齐）
     * - 只负责抛错，不做状态修改
     * -----------------------------*/
    private async assertOrderNotSettlingOrThrow(
        tx: any,
        orderId: number,
        message = '订单正在结算处理中，请稍后再试',
    ) {
        const settlingCount = await tx.orderDispatch.count({
            where: {orderId, status: DispatchStatus.SETTLING as any},
        });
        if (settlingCount > 0) {
            // ✅ 这类属于并发冲突，用 409 更合理（不是 403）
            throw new ConflictException(message);
        }
    }

    /** -----------------------------
     *  读取 billingMode：快照优先，其次 project.billingMode
     * -----------------------------*/
    private getBillingModeFromOrder(order: any): BillingMode | undefined {
        const snapshot: any = order?.projectSnapshot || {};
        return (snapshot.billingMode as any) || (order?.project?.billingMode as any);
    }

    /** -----------------------------
     *  便捷函数 Todo 确认其功能并补充注释
     * -----------------------------*/
    private ensureDispatchStatus(dispatch: { status: DispatchStatus }, allowed: DispatchStatus[], message: string) {
        const allow = new Set<DispatchStatus>(allowed);
        if (!allow.has(dispatch.status)) throw new BadRequestException(message);
    }

    /** -----------------------------
     *  Todo 确认其功能并补充注释
     * -----------------------------*/
    private async getDispatchWithParticipants(dispatchId: number) {
        return this.prisma.orderDispatch.findUnique({
            where: {id: dispatchId},
            include: {
                participants: {include: {user: {select: {id: true, name: true, phone: true}}}},
                order: {select: {id: true, autoSerial: true, status: true}},
            },
        });
    }


    async rollbackWrongSettlementReversals(orderId: number) {
        const oid = Number(orderId);
        if (!oid) {
            throw new BadRequestException('orderId 非法');
        }

        return await this.prisma.$transaction(async (tx) => {
            return await this.rollbackWrongSettlementReversalsByOrderId({
                tx,
                orderId: oid,
            });
        });
    }


    //反修复流水冲正方法(一次性 3-16)
    async rollbackWrongSettlementReversalsByOrderId(params: {
        tx: any;
        orderId: number;
    }) {
        const { tx, orderId } = params;

        const oid = Number(orderId);
        if (!oid) {
            throw new BadRequestException('orderId 非法');
        }

        /**
         * 一次性找出当前订单下两类“错误修复流水”
         * 1) SETTLEMENT_REVERSAL
         * 2) SETTLEMENT_RECALC
         *
         * 当前是临时止血逻辑：
         * 默认认为该订单下现存的这两类流水，都是本次错误修复产生的脏数据
         */
        const wrongTxs = await tx.walletTransaction.findMany({
            where: {
                orderId: oid,
                OR: [
                    {
                        bizType: 'SETTLEMENT_REVERSAL',
                        sourceType: {
                            in: [
                                'ORDER_SETTLEMENT_REVERSAL',
                                'WALLET_HOLD_RELEASE_REVERSAL',
                            ],
                        },
                    },
                    {
                        bizType: 'SETTLEMENT_RECALC',
                    },
                ],
            },
            select: {
                id: true,
                userId: true,
                amount: true,
                direction: true,
                status: true,
                orderId: true,
                dispatchId: true,
                settlementId: true,
                sourceType: true,
                sourceId: true,
                bizType: true,
            },
            orderBy: { id: 'asc' },
        });

        if (!wrongTxs.length) {
            return {
                success: true,
                orderId: oid,
                count: 0,
                createdIds: [],
                reversalRollbackCount: 0,
                recalcRollbackCount: 0,
                message: '未找到可反修复的错误流水',
            };
        }

        const createdIds: number[] = [];
        let reversalRollbackCount = 0;
        let recalcRollbackCount = 0;

        for (const t of wrongTxs) {
            const txId = Number(t.id);
            const userId = Number(t.userId ?? 0);
            const amount = round2(Number(t.amount ?? 0));

            if (!txId || !userId || !amount) continue;

            // ✅ 按不同 bizType 决定回滚流水的 sourceType / bizType
            let rollbackSourceType = '';
            let rollbackBizType = '';

            if (String(t.bizType) === 'SETTLEMENT_REVERSAL') {
                rollbackSourceType = 'SETTLEMENT_REVERSAL_ROLLBACK';
                rollbackBizType = 'SETTLEMENT_REVERSAL';
            } else if (String(t.bizType) === 'SETTLEMENT_RECALC') {
                rollbackSourceType = 'SETTLEMENT_RECALC_ROLLBACK';
                rollbackBizType = 'SETTLEMENT_RECALC';
            } else {
                continue;
            }

            // ✅ 幂等防重：同一条错误流水只允许反修复一次
            const existedRollbackTx = await tx.walletTransaction.findUnique({
                where: {
                    sourceType_sourceId: {
                        sourceType: rollbackSourceType,
                        sourceId: txId,
                    },
                },
                select: { id: true },
            });
            if (existedRollbackTx?.id) {
                continue;
            }

            const account = await tx.walletAccount.findUnique({
                where: { userId },
                select: {
                    id: true,
                    availableBalance: true,
                    frozenBalance: true,
                },
            });

            if (!account) {
                throw new BadRequestException(`钱包账户不存在，userId=${userId}`);
            }

            // 原流水是 OUT，就补 IN；原流水是 IN，就补 OUT
            const reverseDirection = String(t.direction) === 'OUT' ? 'IN' : 'OUT';

            let newAvailable = round2(Number(account.availableBalance ?? 0));
            let newFrozen = round2(Number(account.frozenBalance ?? 0));

            // ✅ 跟着原错误流水所影响的余额侧反向抵消
            if (String(t.status) === 'FROZEN') {
                newFrozen =
                    reverseDirection === 'IN'
                        ? round2(newFrozen + amount)
                        : round2(newFrozen - amount);
            } else {
                newAvailable =
                    reverseDirection === 'IN'
                        ? round2(newAvailable + amount)
                        : round2(newAvailable - amount);
            }

            // if (newAvailable < 0 || newFrozen < 0) {
            //     throw new BadRequestException(
            //         `反修复后余额将变为负数，已阻断。txId=${txId}, bizType=${t.bizType}, userId=${userId}, available=${newAvailable}, frozen=${newFrozen}`,
            //     );
            // }

            // 1) 更新账户余额
            await tx.walletAccount.update({
                where: { userId },
                data: {
                    availableBalance: newAvailable,
                    frozenBalance: newFrozen,
                },
            });

            // 2) 写入反修复流水
            const created = await tx.walletTransaction.create({
                data: {
                    userId,
                    direction: reverseDirection,
                    bizType: rollbackBizType,
                    amount,
                    status: t.status,

                    availableAfter: newAvailable,
                    frozenAfter: newFrozen,

                    sourceType: rollbackSourceType,
                    sourceId: txId,

                    orderId: t.orderId ?? oid,
                    dispatchId: t.dispatchId ?? null,
                    settlementId: t.settlementId ?? null,

                    reversalOfTxId: txId,
                },
                select: { id: true },
            });

            createdIds.push(Number(created.id));

            if (String(t.bizType) === 'SETTLEMENT_REVERSAL') {
                reversalRollbackCount += 1;
            } else if (String(t.bizType) === 'SETTLEMENT_RECALC') {
                recalcRollbackCount += 1;
            }
        }

        return {
            success: true,
            orderId: oid,
            count: createdIds.length,
            createdIds,
            reversalRollbackCount,
            recalcRollbackCount,
            rollbackSourceTxIds: wrongTxs.map((t: any) => Number(t.id)),
        };
    }

    /**
     * ✅ 计算单个陪玩理论收益（保守版）
     * ToDo 计算相关收益公共方法
     * 说明：
     * - 项目真实收益规则可能更复杂（等级/类型/抽成/补收/超时/平台扣点等）
     * - 这里先提供最小实现，让编译通过，并保持“可替换点集中”
     */
    private calcPlayerEarning(params: {
        order: { paidAmount: number; settlementBaseAmount?: number; receivableAmount?: number; originalAmount?: number };
        participantsCount: number;
        ratio?: number;
        _dbg?: { orderId?: number; dispatchId?: number; userId?: number };
    }) {
        const {order, participantsCount, ratio, _dbg} = params;

        const paid = this.getSettlementBaseAmountFromOrder(order);
        const count = Math.max(1, Number(participantsCount || 1));

        // ✅ ratioMap 里 ratio 的语义是“份额 share（总和=1）”
        // - 有 ratio：直接按份额分摊 paid
        // - 无 ratio：默认均分 paid/count
        let baseShare: number;
        if (ratio !== null && ratio !== undefined) {
            const r = Number(ratio);
            baseShare = Number.isFinite(r) ? paid * r : paid / count;
        } else {
            baseShare = paid / count;
        }

        return roundMix1(baseShare);
    }

    /**
     * 计算到手 multiplier（优先级：订单抽成 > 项目抽成 > 陪玩抽成）
     *
     * 规则：
     * - 订单抽成：order.customClubRate（抽成比例 cut） => multiplier = 1 - cut
     *   ⚠️ order.clubRate 仅做历史快照展示，不参与规则计算
     * - 项目抽成：order.projectSnapshot.clubRate（优先）或 order.project.clubRate（抽成比例 cut） => multiplier = 1 - cut
     * - 陪玩抽成：staffRating.rate（抽成比例 cut） => multiplier = 1 - cut
     *
     * 口径兼容：
     * - 10 / 0.1 / 40 / 0.4 都可
     * - 0 也算“已设置”，只有 null/undefined 才算未设置
     *
     * 注意：
     * - 本方法不查 DB，只使用结算瞬间快照（避免结算过程中规则被改导致不一致）
     */
    private resolveMultiplier(
        order: any,
        participant: { userId: number },
        snapshot: {
            // ✅ 结算瞬间快照
            orderCutRaw: any | null;     // order.customClubRate（可为 0）
            projectCutRaw: any | null;   // snapshot.clubRate 或 project.clubRate（可为 0）
            staffCutMap?: Map<number, number>; // staffRating.rate（抽成比例），仅当需要走员工评级时才会传
        },
    ): number {
        // ---------- normalize ----------
        const normalizeToRatio = (v: any, fallback: number) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            return n > 1 ? n / 100 : n; // 兼容 10 / 0.1 / 60 / 0.6
        };
        const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
        const isSet = (v: any) => v !== null && v !== undefined; // ✅ 0 也算已设置

        // ---------- 订单抽成（优先级最高） ----------
        // ✅ 订单固定抽成（平台抽成）
        // 口径：0 或 0.1 表示不抽成或抽 1 成，陪玩到手 = (1 - 0/0.1)
        if (isSet(snapshot.orderCutRaw)) {
            const cut = clamp01(normalizeToRatio(snapshot.orderCutRaw, 0));
            return clamp01(1 - cut);
        }

        // ---------- 项目抽成（快照优先） ----------
        // 项目固定抽成优先取快照，避免项目后改影响历史
        if (isSet(snapshot.projectCutRaw)) {
            const cut = clamp01(normalizeToRatio(snapshot.projectCutRaw, 0));
            return clamp01(1 - cut);
        }

        // ---------- 陪玩抽成（员工评级 staffRating.rate） ----------
        // 员工评级表 staffRating，对应抽成比例字段为 rate
        // ✅ 的业务定义：rate=0.4 表示抽 40%，陪玩到手 = 1 - 0.4 = 0.6
        const staffCut = snapshot.staffCutMap?.get(participant.userId);
        const cut = clamp01(normalizeToRatio(staffCut ?? 0, 0)); // 默认不抽成
        return clamp01(1 - cut);
    }

    /** ===========================
     *  ✅ Helpers（纯工具区域，不改变业务）应提到Utils的应尽快
     * ===========================*/
    /** -----------------------------
     *  解析 boolean：
     *  支持 boolean / number / string，
     *  避免 Boolean("false")===true 的坑
     * -----------------------------*/
    private parseBool(v: any, defaultValue: boolean) {
        if (v === undefined || v === null) return defaultValue;
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;

        if (typeof v === 'string') {
            const s = v.trim().toLowerCase();
            if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
            if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
        }

        return Boolean(v);
    }

    /** ✅ 截断到 1 位小数（不四舍五入）todo 确认功能是否与上面方法一致 */
    private trunc1(v: any): number {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;

        // 1位：乘10后截断再除10
        // 注意：Math.trunc 对负数也是“向0截断”，符合“舍弃”直觉
        return Math.trunc(n * 10) / 10;
    }

    /**
     * 扣时选项映射为分钟数
     */
    private mapDeductMinutesValue(option?: string): number {
        switch (option) {
            case 'M10':
                return 10;
            case 'M20':
                return 20;
            case 'M30':
                return 30;
            case 'M40':
                return 40;
            case 'M50':
                return 50;
            case 'M60':
                return 60;
            default:
                return 0;
        }
    }

    /**
     * ✅ 构建“进度比例”映射，用于存单（ARCHIVE）按贡献分摊
     *
     * 规则（保守版）：
     * - progress 取值范围建议 0~1（如果用 0~100，记得在这里除以 100）
     * - 若所有 progress 都为空/0，则每个参与者按 1 平均
     *
     * 返回：
     * - key: participant.id
     * - value: ratio（0~1）
     */
    private buildProgressRatioMap(participants: Array<{ id: number; progress?: number | null }>) {
        const weightMap = new Map<number, number>();

        // 1) 取权重：progress 有值则用 progress，否则用 1
        for (const p of participants) {
            const raw = p.progress;
            // ✅ 如果 progress 是 0~100（项目有可能），可改为：const w = raw != null ? raw / 100 : 1;
            const w = raw != null ? Number(raw) : 1;
            weightMap.set(p.id, Math.max(0, w));
        }

        // 2) 归一化
        const total = Array.from(weightMap.values()).reduce((a, b) => a + b, 0);

        // 3) total=0 时兜底平均
        if (!total) {
            const avg = participants.length > 0 ? 1 / participants.length : 0;
            const ratioMap = new Map<number, number>();
            for (const p of participants) ratioMap.set(p.id, avg);
            return ratioMap;
        }

        const ratioMap = new Map<number, number>();
        for (const [id, w] of weightMap.entries()) {
            ratioMap.set(id, w / total);
        }
        return ratioMap;
    }


    /**
     * 业绩板块方法
     * */
    private toYmd(date?: Date | string | null) {
        const d = date ? new Date(date) : new Date();
        const y = d.getFullYear();
        const m = `${d.getMonth() + 1}`.padStart(2, '0');
        const day = `${d.getDate()}`.padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    private toYm(date?: Date | string | null) {
        const d = date ? new Date(date) : new Date();
        const y = d.getFullYear();
        const m = `${d.getMonth() + 1}`.padStart(2, '0');
        return `${y}-${m}`;
    }

    private toDecimal2(v: any) {
        const n = Number(v ?? 0);
        if (!Number.isFinite(n)) return 0;
        return Math.round(n * 100) / 100;
    }

    private getOrderTypeFromOrder(order: any): any {
        const snapshot: any = order?.projectSnapshot || {};
        return snapshot?.type ?? order?.project?.type ?? null;
    }

    private getProjectIdFromOrder(order: any): number | null {
        return Number(order?.projectId ?? 0) || null;
    }

    private getCustomerUserIdFromOrder(order: any): number | null {
        return Number(order?.customerUserId ?? 0) || null;
    }

    private getSettlementBaseAmountFromOrder(order: any): number {
        const explicit = Number(order?.settlementBaseAmount ?? 0);
        if (Number.isFinite(explicit) && explicit > 0) return this.toDecimal2(explicit);

        const paid = Number(order?.paidAmount ?? 0);
        if (Number.isFinite(paid) && paid > 0) return this.toDecimal2(paid);

        const receivable = Number(order?.receivableAmount ?? 0);
        if (Number.isFinite(receivable) && receivable > 0) return this.toDecimal2(receivable);

        const original = Number(order?.originalAmount ?? 0);
        if (Number.isFinite(original) && original > 0) return this.toDecimal2(original);

        return 0;
    }

    private getPositiveSettlementPayoutTotal(settlements: any[], extraPositivePayoutAmount = 0): number {
        return this.toDecimal2(
            (settlements || []).reduce((sum: number, s: any) => {
                const finalEarnings = Number(s?.finalEarnings ?? 0);
                if (!Number.isFinite(finalEarnings) || finalEarnings <= 0) return sum;
                return sum + finalEarnings;
            }, 0) + Math.max(0, Number(extraPositivePayoutAmount || 0)),
        );
    }

    private getOrderSettlementSafetyBudget(order: any, settlements: any[], extraAllowanceAmount = 0) {
        const settlementBaseAmount = this.toDecimal2(this.getSettlementBaseAmountFromOrder(order));
        const bombCompensationAllowance = this.toDecimal2(
            (settlements || []).reduce((sum: number, s: any) => {
                const settlementType = String(s?.settlementType || '');
                const finalEarnings = Number(s?.finalEarnings ?? 0);
                if (settlementType === 'CUSTOMER_SERVICE' || !Number.isFinite(finalEarnings) || finalEarnings >= 0) {
                    return sum;
                }
                return sum + Math.abs(finalEarnings);
            }, 0),
        );
        const customerServiceAllowance = this.toDecimal2(
            (settlements || []).reduce((sum: number, s: any) => {
                if (String(s?.settlementType || '') !== 'CUSTOMER_SERVICE') return sum;
                const finalEarnings = Number(s?.finalEarnings ?? 0);
                if (!Number.isFinite(finalEarnings) || finalEarnings <= 0) return sum;
                return sum + finalEarnings;
            }, 0),
        );
        const renewalBonusAllowance = this.toDecimal2(Math.max(0, Number(extraAllowanceAmount || 0)));

        return {
            settlementBaseAmount,
            bombCompensationAllowance,
            customerServiceAllowance,
            renewalBonusAllowance,
            effectiveSettlementBaseAmount: this.toDecimal2(
                settlementBaseAmount + bombCompensationAllowance + customerServiceAllowance + renewalBonusAllowance,
            ),
        };
    }

    private assertOrderSettlementPayoutWithinBase(params: {
        order: any;
        settlements: any[];
        context: string;
        extraPositivePayoutAmount?: number;
        extraAllowanceAmount?: number;
    }) {
        const { order, settlements, context } = params;
        const orderId = Number(order?.id || 0);
        const {
            settlementBaseAmount,
            bombCompensationAllowance,
            customerServiceAllowance,
            renewalBonusAllowance,
            effectiveSettlementBaseAmount,
        } = this.getOrderSettlementSafetyBudget(order, settlements, params.extraAllowanceAmount);
        if (!orderId) {
            throw new BadRequestException('订单结算安全校验失败：缺少订单ID');
        }
        if (!Number.isFinite(settlementBaseAmount) || settlementBaseAmount <= 0) {
            throw new BadRequestException(`订单结算安全校验失败：订单 ${order?.autoSerial || `#${orderId}`} 结算金额非法`);
        }

        const payoutTotal = this.getPositiveSettlementPayoutTotal(settlements, params.extraPositivePayoutAmount);
        if (payoutTotal - effectiveSettlementBaseAmount > 0.01) {
            throw new BadRequestException(
                `订单结算安全拦截：${context} 的正向结算合计 ¥${payoutTotal.toFixed(2)} 不得超过有效结算基数 ¥${effectiveSettlementBaseAmount.toFixed(2)}（订单结算 ¥${settlementBaseAmount.toFixed(2)}，炸单补偿 ¥${bombCompensationAllowance.toFixed(2)}，客服分红 ¥${customerServiceAllowance.toFixed(2)}，续单分红 ¥${renewalBonusAllowance.toFixed(2)}），订单 ${order?.autoSerial || `#${orderId}`}`,
            );
        }
    }

    private async assertPersistedOrderSettlementPayoutWithinBaseTx(params: {
        tx: any;
        order: any;
        context: string;
        extraPositivePayoutAmount?: number;
        extraAllowanceAmount?: number;
    }) {
        const { tx, order, context } = params;
        const orderId = Number(order?.id || 0);
        const settlements = await tx.orderSettlement.findMany({
            where: { orderId },
            select: { id: true, finalEarnings: true, settlementType: true },
        });
        this.assertOrderSettlementPayoutWithinBase({
            order,
            settlements,
            context,
            extraPositivePayoutAmount: params.extraPositivePayoutAmount,
            extraAllowanceAmount: params.extraAllowanceAmount,
        });
    }

    private normalizeSettlementBaseMode(
        mode?: string | null,
    ): 'PAID_AMOUNT' | 'SETTLEMENT_BASE_AMOUNT' {
        const normalized = String(mode ?? '').trim().toUpperCase();
        if (normalized === 'PAID_AMOUNT' || normalized === 'PAID') {
            return 'PAID_AMOUNT';
        }
        if (
            normalized === 'SETTLEMENT_BASE_AMOUNT' ||
            normalized === 'SETTLEMENT_BASE' ||
            normalized === 'ORDER_BASE'
        ) {
            return 'SETTLEMENT_BASE_AMOUNT';
        }
        return 'SETTLEMENT_BASE_AMOUNT';
    }

    private getSettlementBaseAmountForConfirmation(
        order: any,
        mode: 'PAID_AMOUNT' | 'SETTLEMENT_BASE_AMOUNT',
    ): number {
        if (mode === 'PAID_AMOUNT') {
            const paidAmount = Number(
                (order as any)?.isGifted === true
                    ? (order as any)?.receivableAmount ?? 0
                    : (order as any)?.paidAmount ?? 0,
            );
            return this.toDecimal2(Math.max(0, paidAmount));
        }

        return this.getSettlementBaseAmountFromOrder(order);
    }

    private getBizLineFromOrder(order: any): string | null {
        const snapshot: any = order?.projectSnapshot || {};
        return snapshot?.bizLine ?? snapshot?.businessType ?? null;
    }

    private isRefundedOrder(order: any) {
        return order?.status === OrderStatus.REFUNDED;
    }

    private isBombBySettlement(s: any) {
        return Number(s?.finalEarnings ?? 0) < 0;
    }

    /**
     * 生成业绩记录（先删后插，保证同一订单幂等重建）
     */
    /**
     * 生成业绩记录（先删后插，保证同一订单幂等重建）
     */
    private async rebuildPerformanceRecordsForOrder(params: {
        tx: any;
        order: any;
        settlements: any[];
    }) {
        const { tx, order, settlements } = params;

        const statsBaseDate =
            order?.paymentTime ||
            order?.updatedAt ||
            order?.createdAt ||
            new Date();

        const statsDate = new Date(this.toYmd(statsBaseDate));
        const statsMonth = this.toYm(statsBaseDate);
        const billingMode = this.getBillingModeFromOrder(order) ?? null;
        const orderType = this.getOrderTypeFromOrder(order) ?? null;
        const projectId = this.getProjectIdFromOrder(order);
        const bizLine = this.getBizLineFromOrder(order);

        const completedDispatchIds = new Set(
            (order?.dispatches ?? [])
                .filter((d: any) => d?.status === DispatchStatus.COMPLETED)
                .map((d: any) => Number(d.id)),
        );

        const archivedDispatchIds = new Set(
            (order?.dispatches ?? [])
                .filter((d: any) => d?.status === DispatchStatus.ARCHIVED)
                .map((d: any) => Number(d.id)),
        );

        const rows = (settlements || []).map((s: any) => {
            const settlementType = String(s?.settlementType || '');
            const isCs = settlementType === 'CUSTOMER_SERVICE';

            const orderGrossAmount = this.toDecimal2(
                this.getSettlementBaseAmountFromOrder(order),
            );

            const gross = this.toDecimal2(
                Number(
                    isCs
                        ? orderGrossAmount
                        : (
                            s?.grossPerformanceAmount ??
                            s?.contributionBaseAmount ??
                            s?.calculatedEarnings ??
                            0
                        )
                ),
            );

            const net = this.toDecimal2(
                Number(
                    s?.netIncomeAmount ??
                    s?.finalEarnings ??
                    0
                ),
            );

            const negative = net < 0 ? Math.abs(net) : 0;

            let ownerRoleType: any = s?.ownerRoleType || 'PLAYER';
            if (!s?.ownerRoleType && isCs) ownerRoleType = 'CS';

            return {
                orderId: Number(order.id),
                dispatchId: s?.dispatchId ? Number(s.dispatchId) : null,
                settlementId: s?.id ? Number(s.id) : null,

                ownerUserId: Number(s.userId),
                ownerRoleType,

                statsDate,
                statsMonth,

                billingMode,
                orderType,
                projectId,
                bizLine,

                grossPerformanceAmount: gross,
                netIncomeAmount: net,
                negativeIncomeAmount: negative,

                contributionBaseAmount: this.toDecimal2(
                    Number(s?.contributionBaseAmount ?? gross)
                ),
                commissionRate: s?.commissionRate == null ? null : this.toDecimal2(Number(s.commissionRate)),

                isAccepted: true,
                isArchived: archivedDispatchIds.has(Number(s?.dispatchId)),
                isCompleted: completedDispatchIds.has(Number(s?.dispatchId)),
                isBombed: this.isBombBySettlement(s),
                isComplained: false,
                isAfterSale: false,
                isCancelled: this.isRefundedOrder(order),

                complaintOrderAmount: 0,
                complaintPenaltyAmount: 0,

                remark: null,
                status: 'EFFECTIVE' as const,
            };
        });

        await tx.performanceRecord.deleteMany({
            where: { orderId: Number(order.id) },
        });

        if (rows.length) {
            await tx.performanceRecord.createMany({
                data: rows,
            });
        }

        return { count: rows.length };
    }

    /**
     * 整单财务记录（按订单 1 条，upsert）
     */
    /**
     * 按订单重建 / 覆盖财务记录表
     *
     * 设计原则：
     * 1. 一单一条财务记录，使用 upsert
     * 2. 只服务“平台财务口径”，不直接承担人员业绩展示
     * 3. 允许确认结单 / 重算修复后反复覆盖，确保最终结果一致
     * 4. 当前投诉 / 售后 / 优惠券先预留字段，后续真实业务接入后再替换默认值
     */
    private async upsertOrderFinanceRecordForOrder(params: {
        tx: any;
        order: any;
        settlements: any[];
    }) {
        const { tx, order, settlements } = params;

        /**
         * 统计归属时间：
         * 优先 paymentTime，其次 updatedAt / createdAt
         * 目的：
         * - 已付款订单按付款时间归属更合理
         * - 若没有 paymentTime，则至少保证落到某一天
         */
        const statsBaseDate =
            order?.paymentTime ||
            order?.updatedAt ||
            order?.createdAt ||
            new Date();

        const statsDate = new Date(this.toYmd(statsBaseDate));
        const statsMonth = this.toYm(statsBaseDate);

        /**
         * 订单分类维度
         */
        const billingMode = this.getBillingModeFromOrder(order) ?? null;
        const orderType = this.getOrderTypeFromOrder(order) ?? null;
        const projectId = this.getProjectIdFromOrder(order);
        const bizLine = this.getBizLineFromOrder(order);
        const customerUserId = this.getCustomerUserIdFromOrder(order);

        /**
         * 成本汇总口径：
         * - 玩家成本：打手/陪玩实际收益
         * - 客服成本：客服实际收益
         * - 渠道成本：后续如果写入 CHANNEL 角色，这里自动支持
         * - 运营成本：后续如果写入 OPERATION 角色，这里自动支持
         *
         * 注意：
         * 这里按 finalEarnings 汇总，因为财务口径关心的是“实际归属/实际成本”
         */
        let playerCostAmount = 0;
        let csCostAmount = 0;
        let operationCostAmount = 0;
        let channelCostAmount = 0;

        for (const s of settlements || []) {
            const settlementType = String(s?.settlementType || '');
            const ownerRoleType = String(s?.ownerRoleType || '');
            const val = this.toDecimal2(Number(s?.finalEarnings ?? 0));

            if (settlementType === 'CUSTOMER_SERVICE' || ownerRoleType === 'CS') {
                csCostAmount += val;
            } else if (ownerRoleType === 'CHANNEL') {
                channelCostAmount += val;
            } else if (ownerRoleType === 'OPERATION') {
                operationCostAmount += val;
            } else {
                /**
                 * 默认都归入玩家成本
                 * 当前主要覆盖：
                 * - REGULAR
                 * - EXPERIENCE
                 * - 其他打手 settlementType
                 */
                playerCostAmount += val;
            }
        }

        const renewalBonusCostAmount = (Array.isArray(order?.renewalGroups) ? order.renewalGroups : [])
            .filter((group: any) => String(group?.status || '') === 'SETTLED')
            .flatMap((group: any) => Array.isArray(group?.bonuses) ? group.bonuses : [])
            .filter((bonus: any) => String(bonus?.status || '') === 'PAID')
            .reduce((sum: number, bonus: any) => sum + this.toDecimal2(Number(bonus?.bonusShareAmount ?? 0)), 0);
        playerCostAmount += renewalBonusCostAmount;

        playerCostAmount = this.toDecimal2(playerCostAmount);
        csCostAmount = this.toDecimal2(csCostAmount);
        operationCostAmount = this.toDecimal2(operationCostAmount);
        channelCostAmount = this.toDecimal2(channelCostAmount);

        /**
         * 收入口径：
         * - receivableAmount：应收
         * - paidAmount：实收
         *
         * 赠送单：
         * - 财务展示时通常也需要体现订单价值
         * - 所以赠送单这里按 receivableAmount 进入 paidAmount 口径
         *   （如果你后续希望“平台实收=0，赠送成本单独体现”，可以再拆）
         */
        const receivableAmount = this.toDecimal2(Number(order?.receivableAmount ?? 0));
        const paidAmount = this.toDecimal2(
            Number(order?.isGifted ? order?.receivableAmount ?? 0 : order?.paidAmount ?? 0),
        );
        const settlementBaseAmount = this.toDecimal2(this.getSettlementBaseAmountFromOrder(order));

        /**
         * 当前折扣口径：
         * - 先用 应收 - 实收 兜底
         * - 后续接优惠券/活动减免后，再拆到 couponDiscountAmount / otherDiscountAmount
         */
        const discountAmount = this.toDecimal2(
            Math.max(0, receivableAmount - paidAmount),
        );

        /**
         * 当前投诉 / 售后尚未正式接业务逻辑，先写默认 0
         * 后续真实接入后替换这里即可
         */
        const complaintPenaltyAmount = 0;
        const afterSaleCostAmount = 0;

        /**
         * 平台毛利 / 净贡献：
         * 实收
         * - 打手支出
         * - 客服支出
         * - 运营支出
         * - 渠道支出
         * - 投诉扣罚
         * - 售后成本
         *
         * 示例：
         * 560 - 420 - 5.6 = 134.4
         */
        const grossProfitAmount = this.toDecimal2(
            paidAmount
            - playerCostAmount
            - csCostAmount
            - operationCostAmount
            - channelCostAmount
            - complaintPenaltyAmount
            - afterSaleCostAmount,
        );

        /**
         * 统一 upsert 数据
         */
        const data = {
            customerUserId,
            statsDate,
            statsMonth,

            billingMode,
            orderType,
            projectId,
            bizLine,

            receivableAmount,
            paidAmount,
            settlementBaseAmount,
            discountAmount,
            couponDiscountAmount: 0,
            otherDiscountAmount: 0,

            playerCostAmount,
            csCostAmount,
            operationCostAmount,
            channelCostAmount,
            complaintPenaltyAmount,
            afterSaleCostAmount,

            grossProfitAmount,

            isComplained: false,
            isAfterSale: false,
            isCancelled: this.isRefundedOrder(order),

            remark: null,
            status: 'EFFECTIVE' as const,
        };

        /**
         * 一单一条财务记录：
         * - 第一次确认结单：create
         * - 后续重算修复：update 覆盖
         */
        await tx.orderFinanceRecord.upsert({
            where: { orderId: Number(order.id) },
            create: {
                orderId: Number(order.id),
                ...data,
            },
            update: data,
        });

        return {
            orderId: Number(order.id),
            receivableAmount,
            paidAmount,
            playerCostAmount,
            csCostAmount,
            operationCostAmount,
            channelCostAmount,
            grossProfitAmount,
        };
    }

    private async rebuildPerformanceAndFinanceByOrderId(params: {
        tx: any;
        orderId: number;
        settlements?: any[];
    }) {
        const { tx, orderId, settlements } = params;

        const order = await tx.order.findUnique({
            where: { id: Number(orderId) },
            select: {
                id: true,
                receivableAmount: true,
                paidAmount: true,
                settlementBaseAmount: true,
                createdAt: true,
                updatedAt: true,
                paymentTime: true,
                isGifted: true,
                status: true,
                projectId: true,
                // 如果当前 Order 没这个字段，就删掉
                // customerUserId: true,
                projectSnapshot: true,
                dispatcherId: true,
                initialDispatcherId: true,
                dispatcher: {
                    select: {
                        id: true,
                        name: true,
                        userType: true,
                    },
                },
                initialDispatcher: {
                    select: {
                        id: true,
                        name: true,
                        userType: true,
                    },
                },
                dispatches: {
                    where: {
                        status: {
                            in: [DispatchStatus.COMPLETED as any, DispatchStatus.ARCHIVED as any],
                        },
                    },
                    select: {
                        id: true,
                        round: true,
                        status: true,
                    },
                },
                project: {
                    select: {
                        id: true,
                        type: true,
                        billingMode: true,
                    },
                },
                settlements: {
                    where: { orderId: Number(orderId) },
                    orderBy: { id: 'asc' },
                    select: {
                        id: true,
                        orderId: true,
                        dispatchId: true,
                        userId: true,
                        settlementType: true,
                        calculatedEarnings: true,
                        manualAdjustment: true,
                        finalEarnings: true,
                        settledAt: true,
                        user: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
                renewalGroups: {
                    select: {
                        id: true,
                        status: true,
                        bonuses: {
                            select: {
                                id: true,
                                userId: true,
                                status: true,
                                bonusShareAmount: true,
                            },
                        },
                    },
                },
            },
        });

        if (!order) {
            throw new BadRequestException('订单不存在');
        }

        let settlementRows = Array.isArray(settlements) ? settlements : [];

        // ✅ 如果外部没传，就从数据库现有 settlement 重建
        if (!settlementRows.length) {
            settlementRows = (order.settlements || []).map((s: any) => {
                const isCs = String(s?.settlementType || '') === 'CUSTOMER_SERVICE';
                return {
                    id: s.id,
                    orderId: s.orderId,
                    dispatchId: s.dispatchId,
                    userId: s.userId,
                    userName: s?.user?.name,
                    settlementType: s.settlementType,
                    calculatedEarnings: Number(s.calculatedEarnings ?? 0),
                    manualAdjustment: Number(s.manualAdjustment ?? 0),
                    finalEarnings: Number(s.finalEarnings ?? 0),

                    ownerRoleType: isCs ? 'CS' : 'PLAYER',
                    contributionBaseAmount: Number(s.calculatedEarnings ?? 0),
                    commissionRate: null,
                    grossPerformanceAmount: Number(s.calculatedEarnings ?? 0),
                    netIncomeAmount: Number(s.finalEarnings ?? 0),
                };
            });
        }

        await this.rebuildPerformanceRecordsForOrder({
            tx,
            order,
            settlements: settlementRows,
        });

        await this.upsertOrderFinanceRecordForOrder({
            tx,
            order,
            settlements: settlementRows,
        });

        return {
            orderId: Number(orderId),
            settlementCount: settlementRows.length,
        };
    }
}
