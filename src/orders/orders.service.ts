import {BadRequestException, ConflictException, Injectable, NotFoundException} from '@nestjs/common';
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
    OrderType,
    PaymentStatus,
    PlayerWorkStatus,
    UserCouponStatus,
    WalletBizType
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
import { PenaltiesService } from '../penalties/penalties.service';

@Injectable()
export class OrdersService {
    constructor(
        private prisma: PrismaService,
        private wallet: WalletService,
        private notificationsService: NotificationsService,
        private penaltiesService: PenaltiesService,
    ) {
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

    private calcCouponDiscount(params: {
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
                throw new BadRequestException('该优惠券不适用于当前项目');
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
                status: any;
                dispatchCount: number;
            };
        }
    >();;

    /*** -----------------------------
     * 创建订单方法
     * -----------------------------*/
    async createOrder(dto: CreateOrderDto, dispatcherId: number) {
        const project = await this.prisma.gameProject.findUnique({where: {id: dto.projectId}});
        if (!project) throw new NotFoundException('项目不存在');

        // 默认客服分佣：体验单为 0，其他为 0.01
        const defaultCsRate = project.type === 'EXPERIENCE' ? 0 : 0.01;

        // 默认推广分佣：有 inviter 才默认 0.05
        const defaultInviteRate = dto.inviter ? 0.05 : 0;

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
        const giftedAmount = isGifted ? originalAmount : 0;
        const isPaid = dto.isGifted ? false : Boolean(dto.isPaid);

        // 统一优惠汇总（先接基础口径，便于后续无缝接优惠券/活动）
        const couponDiscountAmount = selectedUserCoupon
            ? this.calcCouponDiscount({
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
        const discountType = this.resolveDiscountType({
            couponDiscountAmount,
            activityDiscountAmount,
            giftDiscountAmount,
            manualAdjustAmount,
        });
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
                // receivableAmount: dto.receivableAmount,
                // paidAmount: dto.paidAmount,
                // paymentTime: dto.paymentTime ? new Date(dto.paymentTime) : null,

                // ✅ 赠送单不可强制清零金额，清零后结算会产生错误
                receivableAmount: dto.receivableAmount,
                paidAmount: dto.paidAmount,

                // ✅ 赠送单一般不应有付款时间（也可以按业务改成 now）
                paymentTime: isGifted || isPaid ? null : (dto.paymentTime ? new Date(dto.paymentTime) : null),
                isPaid,

                // orderTime: dto.orderTime ? new Date(dto.orderTime) : null,
                orderTime: new Date(),
                openedAt: new Date(),
                baseAmountWan: dto.baseAmountWan ?? null,

                projectId: project.id,
                projectSnapshot: projectSnapshot as any,

                customerGameId: dto.customerGameId ?? null,

                dispatcherId,

                csRate: dto.csRate ?? defaultCsRate,
                inviteRate: dto.inviteRate ?? defaultInviteRate,
                inviter: dto.inviter ?? null,

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
            });

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

        await this.logOrderAction(dispatcherId, order.id, 'CREATE_ORDER', {
            autoSerial: order.autoSerial,
            projectId: order.projectId,
            paidAmount: order.paidAmount,
        });

        // ✅ 新建即派单：若传了 playerIds，则直接创建首轮派单并指派
        const playerIds = Array.isArray((dto as any)?.playerIds)
            ? (dto as any).playerIds.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
            : [];

        if (playerIds.length > 0) {
            // 复用现有派单逻辑（包含防重复、参与者写入、日志等）
            await this.assignDispatch(order.id, playerIds, dispatcherId, 'AUTO_CREATE');
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
        if (query.playerId) {
            where.dispatches = {
                some: { participants: { some: { userId: query.playerId } } },
            };
        }
        if (query.isPaid !== undefined) where.isPaid = Boolean(query.isPaid);

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

        const [data, total] = await Promise.all([
            this.prisma.order.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                select: {
                    id: true,
                    autoSerial: true,
                    status: true,
                    isPaid: true,
                    isGifted: true,
                    paidAmount: true,
                    customerGameId: true,
                    createdAt: true,
                    project: {
                        select: { id: true, name: true },
                    },
                    dispatcher: { select: { id: true, name: true, phone: true } },
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
            }),
            this.prisma.order.count({ where }),
        ]);

        return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
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
        const order = await this.prisma.order.findUnique({
            where: { id },
            include: {
                project: true,
                dispatcher: {
                    select: { id: true, name: true, phone: true },
                },

                // ✅ 当前派单批次
                currentDispatch: {
                    include: {
                        participants: {
                            where: { isActive: true },
                            include: {
                                user: {
                                    select: {
                                        id: true,
                                        name: true,
                                        phone: true,
                                        workStatus: true,
                                    },
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
                                user: { select: { id: true, name: true, phone: true } },
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
            },
        });

        if (!order) {
            throw new NotFoundException('订单不存在');
        }

        // ===========================
        // 2️⃣ 查询钱包真实流水（保留原始有效流水全集）
        // ===========================
        const walletTxs = await this.prisma.walletTransaction.findMany({
            where: {
                orderId: id,
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
        const settlementTotal = order.settlements.reduce(
            (sum, s) => sum + Number(s.finalEarnings || 0),
            0,
        );

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
        for (const s of order.settlements || []) {
            const uid = Number(s?.userId || 0);
            if (!uid) continue;
            const v = Number(s?.finalEarnings || 0);
            settlementByUser.set(uid, (settlementByUser.get(uid) || 0) + v);
        }

        const userMap = new Map<number, { id: number; name: string; phone?: string }>();
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
        return {
            ...order,

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
            select: {id: true, status: true},
        });

        if (!order) throw new NotFoundException('订单不存在');

        const forbidden = new Set(['COMPLETED', 'REFUNDED']);
        if (forbidden.has(String(order.status))) {
            throw new BadRequestException('当前订单状态不可取消');
        }

        const updated = await this.prisma.order.update({
            where: {id: orderId},
            data: {
                status: 'CANCELLED' as any,
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
                    newData: {status: 'CANCELLED'} as any,
                    remark: remark || '取消订单',
                },
            });
        }

        return updated;
    }

    /*** -----------------------------
     * 派单 / 重新派单（创建新的派单批次）
     *  ARCHIVED 状态也允许再次派单；派单后状态流转与新建订单一致（WAIT_ACCEPT）
     * -----------------------------*/
    async assignDispatch(orderId: number, playerIds: number[], operatorId: number, remark?: string) {
        if (!orderId) throw new BadRequestException('orderId 必填');
        if (!Array.isArray(playerIds)) throw new BadRequestException('playerIds 必须为数组');
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

        // round 从 1 开始递增
        const nextRound = (order.dispatches?.reduce((max, d) => Math.max(max, d.round), 0) || 0) + 1;

        // 创建本轮派单
        const dispatch = await this.prisma.orderDispatch.create({
            data: {
                orderId,
                round: nextRound,
                status: 'WAIT_ACCEPT' as any,
                assignedAt: new Date(),
                remark: remark || null,
            },
        });

        // 创建参与者
        await this.prisma.orderParticipant.createMany({
            data: playerIds.map((userId) => ({
                dispatchId: dispatch.id,
                userId,
                isActive: true,
            })),
        });

        // 更新订单状态 + currentDispatch 指针（状态流转与新建订单一致）
        await this.prisma.order.update({
            where: {id: orderId},
            data: {
                status: 'WAIT_ACCEPT' as any,
                currentDispatchId: dispatch.id,
            },
        });

        // 记录日志
        if (operatorId) {
            await this.prisma.userLog.create({
                data: {
                    userId: operatorId,
                    action: 'ASSIGN_DISPATCH',
                    targetType: 'ORDER',
                    targetId: orderId,
                    oldData: {status: order.status} as any,
                    newData: {status: 'WAIT_ACCEPT', playerIds, round: nextRound} as any,
                    remark: remark || `派单 round=${nextRound}`,
                },
            });
        }

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
        const operatorId: number = user.userId
        const orderId = await this.prisma.$transaction(async (tx) => {
            await this.lockDispatchForSettlementOrThrow(dispatchId, tx);
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
                if (!isParticipant) throw new BadRequestException('你不是本轮派单参与者，无权操作');

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

                // ✅ 4) 派单置存/结单
                await tx.orderDispatch.update({
                    where: {id: dispatchId},
                    data: {
                        status: dispatchStatus,
                        archivedAt: now,
                        completedAt: dispatchStatus === 'COMPLETED' ? now : null,
                        remark: dto.remark ?? dispatch.remark ?? null,
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
                    'ARCHIVE_DISPATCH',
                    {
                        dispatchId,
                        archivedAt: now.toISOString(),
                        orderClass,
                        remark: dto.remark ?? null,
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

        return this.prisma.$transaction(async (tx) => {
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

            const activeParticipants = (dispatch.participants || []).filter((p: any) => p?.isActive !== false);

            // 锁轮判断：已不是 WAIT_ACCEPT / 有人接单 / 有人拒单（含 rejectedAt） => 必须新建一轮
            const hasAccepted = activeParticipants.some((p: any) => !!p.acceptedAt);
            const hasRejected = activeParticipants.some((p: any) => !!p.rejectedAt);

            const shouldCreateNewRound =
                dispatch.status !== DispatchStatus.WAIT_ACCEPT || hasAccepted || hasRejected;

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

            // ✅ 否则：仍在 WAIT_ACCEPT 且无人接单/拒单
            // 不能“全量失效+createMany(skipDuplicates)”；否则同一 user 会因唯一键无法重建活跃记录。
            // 改为：按 userId 差量更新（保留/移除/新增）保证同一参与者可安全改派。
            const activeUserIds = Array.from(new Set(activeParticipants.map((p: any) => Number(p.userId))));
            const targetSet = new Set(target);
            const toDisable = activeUserIds.filter((uid) => !targetSet.has(uid));

            if (toDisable.length > 0) {
                await tx.orderParticipant.updateMany({
                    where: {
                        dispatchId,
                        userId: { in: toDisable },
                        isActive: true,
                    },
                    data: { isActive: false },
                });
            }

            // 对目标参与者做 upsert，兼容“同一人重新指派”
            for (const uid of target) {
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
                removedUserIds: toDisable,
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
            await this.refreshPlayerWorkStatusByActiveAcceptedDispatches(tx, toDisable);
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

        return this.prisma.$transaction(async (tx) => {
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
        },
    ) {
        orderId = Number(orderId);
        operatorId = Number(operatorId);
        if (!orderId) throw new BadRequestException('orderId 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');
        const staffLiable = Boolean(options?.staffLiable);
        const hasCompensation = Boolean(options?.hasCompensation);

        const order = await this.prisma.order.findUnique({
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
            },
        });
        if (!order) throw new NotFoundException('订单不存在');

        // 已退款幂等
        if (order.status === OrderStatus.REFUNDED) return this.getOrderDetail(orderId);

        // 若已打款，不允许退款清零（避免财务对不上）
        const hasPaid = order.settlements?.some((s) => s.paymentStatus === PaymentStatus.PAID);
        if (hasPaid) throw new BadRequestException('存在已打款结算记录，禁止退款（请先走财务冲正流程）');

        const settlementUserIds = Array.from(
            new Set(
                (order.settlements || [])
                    .map((x) => Number((x as any).userId))
                    .filter((n) => Number.isFinite(n) && n > 0),
            ),
        );
        const participantUserIds = Array.from(
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
        const customLiableUserIds = Array.isArray(options?.liableUserIds)
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

                // 同步汇总
                await tx.order.update({
                    where: {id: orderId},
                    data: {
                        totalPlayerEarnings: 0,
                    },
                });
                // ✅ 4) 钱包冲正
                await this.wallet.reverseOrderSettlementEarnings({orderId}, tx);
            }
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
            },
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
                isPaid: true,
                isGifted: true,
                giftedAmount: true,

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
                dispatcher: {
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
                                    select: {
                                        id: true,
                                        name: true,
                                        userType: true,
                                        staffRating: {
                                            select: {
                                                rate: true,
                                            },
                                        },
                                    },
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
    }) {
        const { order, modePlayAllocList } = params;

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

        if (!Array.isArray(settlementsToCreate) || !settlementsToCreate.length) {
            throw new BadRequestException('未生成可写入的结算计划');
        }

        return {
            billingMode,
            settlementsToCreate,
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

        const freezeInfo = computeSettlementFreezeTime({ order });
        const unlockAt = freezeInfo.freezeEndAt;
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
                settlementBatchId,
                paymentStatus: 'UNPAID',
            }));

        if (!settlementCreateData.length) {
            throw new BadRequestException('settlementCreateData 为空，无法写入');
        }

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
                const w = await this.wallet.applySettlementEarningToWalletV1({
                    tx,
                    userId: s.userId,
                    settlementId: s.id,
                    orderId,
                    dispatchId: s.dispatchId,
                    finalEarnings: Number(s.finalEarnings ?? 0),
                    unlockAt,
                    freezeWhenPositive: true,
                });

                walletResults.push({
                    settlementId: s.id,
                    userId: s.userId,
                    dispatchId: s.dispatchId,
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
                    userName: extra.userName,
                };
            });

            return {
                mode,
                orderId,
                settlementBatchId,
                freezeDays: freezeInfo.freezeDays,
                freezeStartAt: freezeInfo.freezeStartAt,
                freezeEndAt: freezeInfo.freezeEndAt,
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

            /**
             * Step 1：生成旧钱包冲正计划
             */
            const rollbackSettlementResult = await this.wallet.rollbackOrderWalletImpactInTxV2({
                tx,
                settlementIds: oldSettlementIds,
            });

            /**
             * Step 2：执行旧结算主流水/解冻流水冲正
             */
            const reversalApplyResults: any[] = [];
            for (const plan of rollbackSettlementResult.reversalPlans ?? []) {
                const r = await this.wallet.applySettlementEarningToWalletV2({
                    tx,
                    userId: plan.userId,
                    settlementId: plan.settlementId ?? null,
                    orderId: plan.orderId ?? orderId,
                    dispatchId: plan.dispatchId ?? null,
                    finalEarnings: Number(plan.finalEarnings ?? 0),

                    unlockAt: null,
                    freezeWhenPositive: false,

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

                const originalDirection = String(t.direction);
                const reversalFinalEarnings = originalDirection === 'OUT' ? amount : -amount;

                const r = await this.wallet.applySettlementEarningToWalletV2({
                    tx,
                    userId: t.userId,
                    settlementId: t.settlementId ?? null,
                    orderId: t.orderId ?? orderId,
                    dispatchId: t.dispatchId ?? null,
                    finalEarnings: reversalFinalEarnings,

                    unlockAt: null,
                    freezeWhenPositive: false,

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
                },
            });

            if (createdSettlements.length !== settlementCreateData.length) {
                throw new BadRequestException(
                    `重建结算条数不一致：期望=${settlementCreateData.length}, 实际=${createdSettlements.length}`,
                );
            }

            /**
             * Step 6：写新“重算收益流水”
             * - 修复类统一不冻结
             */
            const recalcApplyResults: any[] = [];
            for (const s of createdSettlements) {
                const r = await this.wallet.applySettlementEarningToWalletV2({
                    tx,
                    userId: s.userId,
                    settlementId: s.id,
                    orderId,
                    dispatchId: s.dispatchId,
                    finalEarnings: Number(s.finalEarnings ?? 0),

                    unlockAt: null,
                    freezeWhenPositive: false,

                    bizTypeOverride: WalletBizType.SETTLEMENT_RECALC,
                    sourceTypeOverride: 'ORDER_SETTLEMENT_RECALC',
                    sourceIdOverride: s.id,
                });

                recalcApplyResults.push({
                    settlementId: s.id,
                    userId: s.userId,
                    dispatchId: s.dispatchId,
                    finalEarnings: Number(s.finalEarnings ?? 0),
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
                    userName: extra.userName,
                };
            });

            return {
                mode,
                orderId,
                settlementBatchId,
                oldSettlementCount: oldSettlements.length,
                deletedOldSettlementCount: deleteOldSettlementResult.count,
                rebuiltSettlementCount: mergedSettlements.length,
                freezeDays: freezeInfo.freezeDays,
                freezeStartAt: freezeInfo.freezeStartAt,
                freezeEndAt: freezeInfo.freezeEndAt,
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
            confirmPaid?: any;
            modePlayAllocList?: any;
        },
    ) {
        orderId = Number(orderId);
        operatorId = Number(operatorId);

        if (!orderId) throw new BadRequestException('orderId 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');

        const remark = dto?.remark;

        return this.prisma.$transaction(async (tx) => {
            /**
             * Step 0：并发保护
             */
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

            if ((latestOrder as any).isPaid !== true && (latestOrder as any).isGifted !== true) {
                throw new BadRequestException('未收款订单不允许最终确认结单');
            }

            /**
             * Step 5：构建 settlement 计划
             */
            const { settlementsToCreate } = await this.buildSettlementPlanFromOrder({
                order: latestOrder,
                modePlayAllocList: dto?.modePlayAllocList,
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
                action: 'CONFIRM_COMPLETE_ORDER_V3',
                remark: remark || '客服确认最终结单',
                orderStatusToUpdate: OrderStatus.COMPLETED,
                logExtra: {
                    settlementBatchId: result.settlementBatchId,
                    freezeDays: result.freezeDays,
                    freezeStartAt: result.freezeStartAt,
                    freezeEndAt: result.freezeEndAt,
                },
            });

            return {
                orderId,
                status: OrderStatus.COMPLETED,
                settlementBatchId: result.settlementBatchId,
                rebuiltSettlementCount: result.rebuiltSettlementCount,
                freezeDays: result.freezeDays,
                freezeStartAt: result.freezeStartAt,
                freezeEndAt: result.freezeEndAt,
            };
        });
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
        type?: '' | 'RECALCULATE';
        scope?: 'COMPLETED_AND_ARCHIVED' | 'COMPLETED_ONLY' | 'ARCHIVED_ONLY';
        modePlayAllocList?: any;
    }) {
        const {
            orderId,
            operatorId,
            reason,
            dryRun = false,
            applyRepair = false,
            scope = 'COMPLETED_AND_ARCHIVED',
            modePlayAllocList,
        } = params;

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

            /**
             * Step 2：dryRun / applyRepair 共用 settlement 计划
             */
            const { billingMode, settlementsToCreate } = await this.buildSettlementPlanFromOrder({
                order,
                modePlayAllocList,
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
                        status: order.status,
                        dispatchCount: Number(order.dispatches?.length ?? 0),
                    },
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
                    status: any;
                    dispatchCount: number;
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
                    String(snap?.status ?? '') !== String(order.status ?? '') ||
                    Number(snap?.dispatchCount ?? 0) !== Number(order.dispatches?.length ?? 0) ||
                    currentUpdatedAt !== cachedUpdatedAt
                ) {
                    throw new BadRequestException('订单数据已变化，请重新 dryRun 后再 applyRepair');
                }

                planToApply = cached.settlementsToCreate;
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
            data: {workStatus: 'WORKING' as any},
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
     * 我的接单记录 / 工作台
     * 我的接单记录（陪玩端/员工端查看自己参与的派单批次）
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
    async lockDispatchForSettlementOrThrow(dispatchId: number, tx: any) {
        const locked = await tx.orderDispatch.updateMany({
            where: {id: dispatchId, status: DispatchStatus.ACCEPTED},
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
        // v0.2 测试参数：冻结时间用“分钟”
        // ===========================
        const EXPERIENCE_UNLOCK_MINUTES = 3 * 60 * 24;
        const REGULAR_UNLOCK_MINUTES = 7 * 60 * 24;

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
            include: {project: true},
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
        // - ✅ 已完成（COMPLETED/ARCHIVED）：参与者已被置为历史（isActive=false），此时必须使用历史参与者来重算/落库
        const dispatchStatus: any = (dispatch as any).status;

        const isFinalized =
            dispatchStatus === (DispatchStatus as any).COMPLETED ||
            dispatchStatus === (DispatchStatus as any).ARCHIVED;

        const participants = (dispatch.participants || []).filter((p: any) => {
            if (p?.rejectedAt) return false;
            return isFinalized ? true : !!p?.isActive;
        });

        if (participants.length === 0) return true;

        // 3️⃣ 本轮基础结算类型（体验单 / 正价单）
        const baseSettlementType = order.type === OrderType.EXPERIENCE ? 'EXPERIENCE' : 'REGULAR';

        // 解冻时间
        const unlockAt =
            baseSettlementType === 'EXPERIENCE'
                ? new Date(Date.now() + EXPERIENCE_UNLOCK_MINUTES * 60 * 1000)
                : new Date(Date.now() + REGULAR_UNLOCK_MINUTES * 60 * 1000);

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

        // paidAmount 仍要校验（旧口径也依赖它）
        const paidAmount = Number((order as any).paidAmount ?? 0);
        if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
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

            rateWanPerYuan = roundMix1(baseAmountWan / paidAmount);
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
            remainingPaidPool = Math.max(0, roundMix1(paidAmount - consumedPaidPool));

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
                            unlockAt,
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
                            unlockAt,
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

        // ===========================
        if (!isCsExcluded && mode === 'COMPLETE' && CUSTOMER_SERVICE_SHARE_RATE > 0 && order.dispatcherId) {
            const csAmount = roundMix1((order.paidAmount ?? 0) * CUSTOMER_SERVICE_SHARE_RATE);
            if (csAmount > 0) {
                const csFound = await tx.orderSettlement.findUnique({
                    where: {
                        dispatchId_userId_settlementType: {
                            dispatchId,
                            userId: order.dispatcherId,
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
                            userId: order.dispatcherId,
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
                            userId: order.dispatcherId,
                            finalEarnings: csFinal,
                            unlockAt,
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
            order.dispatcherId,
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
        order: { paidAmount: number };
        participantsCount: number;
        ratio?: number;
        _dbg?: { orderId?: number; dispatchId?: number; userId?: number };
    }) {
        const {order, participantsCount, ratio, _dbg} = params;

        const paid = Number(order?.paidAmount || 0);
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
                Number(
                    order?.paidAmount ??
                    order?.receivableAmount ??
                    0
                ),
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
                dispatcher: {
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
