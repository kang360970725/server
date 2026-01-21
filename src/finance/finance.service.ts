import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ReconcileSummaryDto } from './dto/reconcile-summary.dto';
import { ReconcileOrdersDto } from './dto/reconcile-orders.dto';
import { ReconcileOrderDetailDto } from './dto/reconcile-order-detail.dto';
import { UserType, WalletBizType } from '@prisma/client';

/**
 * 财务核账模块（只读审计）
 *
 * 口径（你已确认）：
 * 1) 收入口径：仅统计 isPaid=true 的订单 paidAmount
 * 2) 统计时间：按“收款时间” Order.paymentTime（summary 仍按此口径）
 * 3) 退款：退款发生后不扣接单数；支出必须出现冲正流水才算退款完成
 *
 * ✅ 本次修复重点（你确认 1.A）：
 * - orders 列表：默认展示“全部订单”（不论状态/是否退款/是否已付款）
 * - orders 列表时间：按 Order.openedAt 范围筛选（而不是 paymentTime）
 * - 退款未冲正的订单必须能被看到（避免被过滤掉）
 */
@Injectable()
export class FinanceService {
    constructor(private prisma: PrismaService) {}

    // ------------------------
    // 权限：FINANCE / SUPER_ADMIN 才能用核账
    // ------------------------
    private ensureFinanceAccess(reqUser: any) {
        const t = reqUser?.userType;
        if (t === UserType.SUPER_ADMIN || t === UserType.FINANCE) return;
        throw new ForbiddenException('无权限：仅财务/超管可进行核账查询');
    }

    // 兼容各种 JWT payload 字段名（避免你策略里字段名不同导致线上直接 403/500）
    private getReqUserId(reqUser: any) {
        const userId = Number(reqUser?.userId ?? reqUser?.id ?? reqUser?.sub);
        if (!Number.isFinite(userId) || userId <= 0) throw new BadRequestException('无效登录信息');
        return userId;
    }

    private parseDateOrThrow(v: string, fieldName: string) {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw new BadRequestException(`${fieldName} 非法`);
        return d;
    }

    private toNumber(v: any) {
        // Prisma Decimal 可能是 string/Decimal 对象/number，这里统一转 number
        if (v === null || v === undefined) return 0;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') return Number(v) || 0;
        if (typeof v?.toNumber === 'function') return v.toNumber();
        return Number(v) || 0;
    }

    private isTruthyBoolean(v: any) {
        return v === true || v === 'true' || v === 1 || v === '1';
    }

    /**
     * 写 UserLog（财务核账属于关键审计动作：至少“查询行为”可追溯）
     * - targetType：FINANCE_RECONCILE
     * - targetId：可空
     * - oldData：空
     * - newData：记录查询条件（注意不要放敏感信息）
     */
    private async writeUserLog(params: {
        userId: number;
        action: string;
        targetId?: number;
        remark?: string;
        newData?: any;
        req?: any;
    }) {
        const { userId, action, targetId, remark, newData, req } = params;

        // 这里不做强依赖：写日志失败不应该影响对账查询（审计优先级低于读）
        try {
            await this.prisma.userLog.create({
                data: {
                    userId,
                    action,
                    targetType: 'FINANCE_RECONCILE',
                    targetId: targetId ?? null,
                    oldData: null,
                    newData: newData ?? null,
                    remark: remark ?? null,
                    ip: req?.ip ?? null,
                    userAgent: req?.headers?.['user-agent'] ?? null,
                },
            });
        } catch {
            // ignore
        }
    }

    /**
     * 退款完成判定（你已确认的硬规则）：
     * - 必须存在冲正流水才算退款完成
     * - 判定条件（任一满足即可）：
     *   1) WalletTransaction.bizType = REFUND_REVERSAL
     *   2) WalletTransaction.reversalOfTxId 非空
     */
    private async buildRefundReversalMap(orderIds: number[]) {
        if (!orderIds.length) return new Map<number, boolean>();

        const rows = await this.prisma.walletTransaction.findMany({
            where: {
                orderId: { in: orderIds },
                OR: [{ bizType: WalletBizType.REFUND_REVERSAL }, { reversalOfTxId: { not: null } }],
            },
            select: { orderId: true },
        });

        const map = new Map<number, boolean>();
        for (const r of rows) {
            if (r.orderId) map.set(Number(r.orderId), true);
        }
        return map;
    }

    // =========================================================
    // 1) 总览统计（口径不变：paymentTime + isPaid=true）
    // =========================================================
    async summary(reqUser: any, dto: ReconcileSummaryDto, req?: any) {
        this.ensureFinanceAccess(reqUser);
        const operatorId = this.getReqUserId(reqUser);

        const startAt = this.parseDateOrThrow(dto.startAt, 'startAt');
        const endAt = this.parseDateOrThrow(dto.endAt, 'endAt');
        if (startAt >= endAt) throw new BadRequestException('startAt 必须小于 endAt');

        const includeGifted = this.isTruthyBoolean(dto.includeGifted);

        // 订单筛选：收入口径 + 收款时间口径
        const orderWhere: any = {
            isPaid: true,
            paymentTime: { gte: startAt, lte: endAt },
        };
        if (!includeGifted) orderWhere.isGifted = false;

        // 只做“汇总”就尽量用聚合，避免读爆
        const [agg, totalOrdersPaid, refundedOrders] = await this.prisma.$transaction([
            this.prisma.order.aggregate({
                where: orderWhere,
                _sum: { paidAmount: true },
            }),
            this.prisma.order.count({ where: orderWhere }),
            this.prisma.order.findMany({
                where: { ...orderWhere, status: 'REFUNDED' },
                select: { id: true, paidAmount: true },
            }),
        ]);

        const totalIncome = this.toNumber(agg?._sum?.paidAmount);

        const refundedOrderIds = refundedOrders.map((o) => Number(o.id));
        const reversalMap = await this.buildRefundReversalMap(refundedOrderIds);

        const refundCount = refundedOrders.length;
        const refundCompletedCount = refundedOrders.filter((o) => reversalMap.get(Number(o.id)) === true).length;
        const refundPendingCount = refundCount - refundCompletedCount;

        // 支出：以“结算结果”为主（应得），可追溯；按订单集合聚合
        // - 这里按“收款时间范围内的订单”来计算支出（你选的时间口径是 paymentTime）
        const paidOrderIdsRows = await this.prisma.order.findMany({
            where: orderWhere,
            select: { id: true, paidAmount: true },
        });
        const paidOrderIds = paidOrderIdsRows.map((o) => Number(o.id));

        let totalPlayerExpense = 0;
        let totalCsExpense = 0;

        if (paidOrderIds.length) {
            const settlements = await this.prisma.orderSettlement.findMany({
                where: { orderId: { in: paidOrderIds } },
                select: { finalEarnings: true, csEarnings: true },
            });

            for (const s of settlements) {
                totalPlayerExpense += this.toNumber(s.finalEarnings);
                totalCsExpense += this.toNumber(s.csEarnings);
            }
        }

        const totalExpense = totalPlayerExpense + totalCsExpense;
        const net = totalIncome - totalExpense;

        // 关键审计：财务查询行为记一条日志（方便追责/回放）
        await this.writeUserLog({
            userId: operatorId,
            action: 'FINANCE_RECONCILE_SUMMARY',
            remark: '财务核账-总览统计查询',
            newData: { startAt: dto.startAt, endAt: dto.endAt, includeGifted },
            req,
        });

        return {
            range: { startAt, endAt },
            income: {
                rule: 'isPaid=true 的 paidAmount（按 paymentTime 统计）',
                totalIncome,
                paidOrders: totalOrdersPaid,
                includeGifted,
            },
            expense: {
                rule: '以结算结果为主（OrderSettlement.finalEarnings + csEarnings），按订单 paymentTime 范围归集',
                totalPlayerExpense,
                totalCsExpense,
                totalExpense,
            },
            refund: {
                rule: '退款不扣接单数；支出必须有冲正流水才算完成',
                refundCount,
                refundCompletedCount,
                refundPendingCount,
            },
            net: {
                net,
                formula: '净额 = 实收 - 累计支出',
            },
        };
    }

    // =========================================================
    // 2) 每单一列（✅修复：默认查全部订单，按 openedAt）
    // =========================================================
    async orders(reqUser: any, dto: ReconcileOrdersDto, req?: any) {
        this.ensureFinanceAccess(reqUser);
        const operatorId = this.getReqUserId(reqUser);

        const startAt = this.parseDateOrThrow(dto.startAt, 'startAt');
        const endAt = this.parseDateOrThrow(dto.endAt, 'endAt');
        if (startAt >= endAt) throw new BadRequestException('startAt 必须小于 endAt');

        const page = Math.max(1, Number(dto.page ?? 1));
        const pageSize = Math.min(100, Math.max(1, Number(dto.pageSize ?? 20)));
        const skip = (page - 1) * pageSize;

        const includeGifted = this.isTruthyBoolean(dto.includeGifted);

        /**
         * ✅【核心修复点】
         * 核账 orders 列表必须“默认展示全部订单”，用于发现：
         * - 已退款但未冲正（必须能看到）
         * - 未付款但已结算/已产生支出（异常）
         * - 其它状态机边界问题
         *
         * 因此：
         * - 不再用 isPaid/paymentTime 过滤列表
         * - 列表时间口径：按 openedAt（你确认 1.A）
         */
        const where: any = {
            openedAt: { gte: startAt, lte: endAt },
        };
        if (!includeGifted) where.isGifted = false;
        if (dto.autoSerial) where.autoSerial = dto.autoSerial;

        /**
         * playerId 过滤（最小改动策略）：
         * - 你原实现：通过结算表反查 orderId（“严格按参与结算”）
         * - 这是稳定逻辑，我不推翻
         * - 注意：如果订单还没结算，则不会被此过滤命中（符合“按结算参与核账”的严格口径）
         */
        if (dto.playerId) {
            const rows = await this.prisma.orderSettlement.findMany({
                where: { userId: Number(dto.playerId) },
                select: { orderId: true },
            });
            const ids = Array.from(new Set(rows.map((r) => Number(r.orderId))));
            if (!ids.length) {
                await this.writeUserLog({
                    userId: operatorId,
                    action: 'FINANCE_RECONCILE_ORDERS',
                    remark: '财务核账-订单列表查询（playerId 过滤命中 0）',
                    newData: {
                        startAt: dto.startAt,
                        endAt: dto.endAt,
                        includeGifted,
                        autoSerial: dto.autoSerial ?? null,
                        playerId: dto.playerId ?? null,
                        onlyAbnormal: this.isTruthyBoolean(dto.onlyAbnormal),
                        page,
                        pageSize,
                    },
                    req,
                });

                return { page, pageSize, total: 0, rows: [] };
            }
            where.id = { in: ids };
        }

        const [total, orders] = await this.prisma.$transaction([
            this.prisma.order.count({ where }),
            this.prisma.order.findMany({
                where,
                // ✅ 列表按 openedAt 倒序（与筛选字段一致）
                orderBy: { openedAt: 'desc' },
                skip,
                take: pageSize,
                select: {
                    id: true,
                    autoSerial: true,
                    paidAmount: true,
                    isPaid: true,
                    isGifted: true,
                    status: true,
                    paymentTime: true,
                    openedAt: true,
                },
            }),
        ]);

        const orderIds = orders.map((o) => Number(o.id));
        const reversalMap = await this.buildRefundReversalMap(orderIds);

        // 结算明细批量取回（含打手姓名 + 评级比例）
        const settlements = orderIds.length
            ? await this.prisma.orderSettlement.findMany({
                where: { orderId: { in: orderIds } },
                select: {
                    orderId: true,
                    userId: true,
                    finalEarnings: true,
                    csEarnings: true,
                    user: {
                        select: {
                            id: true,
                            name: true,
                            rating: true,
                            staffRating: { select: { rate: true } },
                        },
                    },
                },
            })
            : [];

        // 按 orderId 分组
        const byOrder = new Map<number, any[]>();
        for (const s of settlements) {
            const oid = Number(s.orderId);
            if (!byOrder.has(oid)) byOrder.set(oid, []);
            byOrder.get(oid)!.push(s);
        }

        const rows = orders.map((o) => {
            const oid = Number(o.id);

            // ✅ 收入口径：展示列“收入(实收)”严格按 isPaid=true
            const rawPaidAmount = this.toNumber(o.paidAmount);
            const paidAmount = o.isPaid ? rawPaidAmount : 0;

            const sList = byOrder.get(oid) ?? [];

            // 参与成员：按你需要的“张三(评级比例)-收益多少”
            const participants = sList.map((s) => {
                const rate = this.toNumber(s.user?.staffRating?.rate); // 例如 0.3 / 0.6
                return {
                    userId: s.userId,
                    name: s.user?.name ?? `User#${s.userId}`,
                    rate,
                    earnings: this.toNumber(s.finalEarnings),
                };
            });

            const totalPlayerExpense = sList.reduce((sum, s) => sum + this.toNumber(s.finalEarnings), 0);
            const totalCsExpense = sList.reduce((sum, s) => sum + this.toNumber(s.csEarnings), 0);
            const totalExpense = totalPlayerExpense + totalCsExpense;

            const profit = paidAmount - totalExpense;

            const isRefunded = o.status === 'REFUNDED';
            const refundCompleted = isRefunded ? reversalMap.get(oid) === true : false;

            // 退款金额：你 schema 里没单独字段，这里按“实收金额口径”先给 paidAmount（已按 isPaid 归零）
            const refundAmount = isRefunded ? paidAmount : 0;

            // 异常判定（用于 onlyAbnormal）
            const abnormalReasons: string[] = [];
            // 1) 倒挂：支出 > 实收（实收按 isPaid=true）
            if (totalExpense > paidAmount) abnormalReasons.push('累计支出 > 实收（倒挂）');
            // 2) 已退款但未冲正（你最关心的点）
            if (isRefunded && !refundCompleted) abnormalReasons.push('已退款但未冲正（退款未完成）');
            // 3) 未收款但已有支出（通常表示流程/数据异常）
            if (!o.isPaid && totalExpense > 0) abnormalReasons.push('未收款但已产生结算支出（疑似异常）');

            return {
                orderId: oid,
                autoSerial: o.autoSerial,
                paymentTime: o.paymentTime,
                openedAt: o.openedAt,
                status: o.status,

                income: {
                    paidAmount,
                    // 冗余给财务抽查：原始字段值，方便定位“paidAmount 有值但 isPaid=false”的异常
                    rawPaidAmount,
                    isPaid: o.isPaid,
                    isGifted: o.isGifted,
                },

                participants, // 张三/李四...
                csExpense: totalCsExpense,
                totalExpense,
                profit,

                refund: {
                    isRefunded,
                    refundAmount,
                    refundCompleted,
                },

                abnormal: {
                    isAbnormal: abnormalReasons.length > 0,
                    reasons: abnormalReasons,
                },
            };
        });

        const filteredRows = dto.onlyAbnormal ? rows.filter((r) => r.abnormal.isAbnormal) : rows;

        await this.writeUserLog({
            userId: operatorId,
            action: 'FINANCE_RECONCILE_ORDERS',
            remark: '财务核账-订单列表查询（默认全状态，按 openedAt）',
            newData: {
                startAt: dto.startAt,
                endAt: dto.endAt,
                includeGifted,
                autoSerial: dto.autoSerial ?? null,
                playerId: dto.playerId ?? null,
                onlyAbnormal: this.isTruthyBoolean(dto.onlyAbnormal),
                page,
                pageSize,
            },
            req,
        });

        /**
         * ✅ 注意：onlyAbnormal=true 时，这里 total 仍然返回“查询范围内订单总数”
         * - 这样分页行为稳定，不会出现“第一页 total=xx，第二页 total=yy”的混乱
         * - 前端如果希望“异常总数”，可以后续单独加一个 countAbnormal（不影响本次最小改动）
         */
        return {
            page,
            pageSize,
            total,
            rows: filteredRows,
        };
    }

    // =========================================================
    // 3) 单订单抽查（原逻辑保留）
    // =========================================================
    async orderDetail(reqUser: any, dto: ReconcileOrderDetailDto, req?: any) {
        this.ensureFinanceAccess(reqUser);
        const operatorId = this.getReqUserId(reqUser);

        let orderId: number | null = dto.orderId ? Number(dto.orderId) : null;

        if (!orderId && dto.autoSerial) {
            const o = await this.prisma.order.findUnique({
                where: { autoSerial: dto.autoSerial },
                select: { id: true },
            });
            if (!o) throw new BadRequestException('订单编号不存在');
            orderId = Number(o.id);
        }

        if (!orderId || !Number.isFinite(orderId) || orderId <= 0) {
            throw new BadRequestException('orderId 或 autoSerial 必填其一');
        }

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                autoSerial: true,
                receivableAmount: true,
                paidAmount: true,
                isPaid: true,
                paymentTime: true,
                isGifted: true,
                status: true,
                openedAt: true,
                dispatcherId: true,
            },
        });
        if (!order) throw new BadRequestException('订单不存在');

        const settlements = await this.prisma.orderSettlement.findMany({
            where: { orderId },
            orderBy: { id: 'asc' },
            select: {
                id: true,
                dispatchId: true,
                userId: true,
                settlementType: true,
                settlementBatchId: true,
                calculatedEarnings: true,
                manualAdjustment: true,
                finalEarnings: true,
                csEarnings: true,
                paymentStatus: true,
                settledAt: true,
                adjustedBy: true,
                adjustedAt: true,
                adjustRemark: true,
                user: {
                    select: {
                        id: true,
                        name: true,
                        rating: true,
                        staffRating: { select: { rate: true } },
                    },
                },
            },
        });

        // 钱包流水：按 orderId 关联取回（含冲正链路）
        const walletTxs = await this.prisma.walletTransaction.findMany({
            where: { orderId },
            orderBy: { id: 'desc' },
            select: {
                id: true,
                userId: true,
                direction: true,
                bizType: true,
                amount: true,
                status: true,
                sourceType: true,
                sourceId: true,
                settlementId: true,
                reversalOfTxId: true,
                createdAt: true,
                availableAfter: true,
                frozenAfter: true,
            },
        });

        const refundCompleted =
            order.status === 'REFUNDED'
                ? walletTxs.some((t) => t.bizType === WalletBizType.REFUND_REVERSAL || t.reversalOfTxId !== null)
                : false;

        const totalPlayerExpense = settlements.reduce((sum, s) => sum + this.toNumber(s.finalEarnings), 0);
        const totalCsExpense = settlements.reduce((sum, s) => sum + this.toNumber(s.csEarnings), 0);
        const totalExpense = totalPlayerExpense + totalCsExpense;

        const paidAmount = this.toNumber(order.paidAmount);
        const profit = (order.isPaid ? paidAmount : 0) - totalExpense;

        await this.writeUserLog({
            userId: operatorId,
            action: 'FINANCE_RECONCILE_ORDER_DETAIL',
            targetId: orderId,
            remark: '财务核账-订单抽查详情',
            newData: { orderId, autoSerial: order.autoSerial },
            req,
        });

        return {
            order: {
                ...order,
                // 这里不改原字段，只做数字化；前端展示“实收”仍应按 isPaid 口径处理
                paidAmount,
                receivableAmount: this.toNumber(order.receivableAmount),
            },
            settlements: settlements.map((s) => ({
                ...s,
                calculatedEarnings: this.toNumber(s.calculatedEarnings),
                manualAdjustment: this.toNumber(s.manualAdjustment),
                finalEarnings: this.toNumber(s.finalEarnings),
                csEarnings: this.toNumber(s.csEarnings),
                user: {
                    userId: s.userId,
                    name: s.user?.name ?? `User#${s.userId}`,
                    rate: this.toNumber(s.user?.staffRating?.rate),
                },
            })),
            walletTransactions: walletTxs.map((t) => ({
                ...t,
                availableAfter: this.toNumber(t.availableAfter),
                frozenAfter: this.toNumber(t.frozenAfter),
            })),
            stats: {
                income: order.isPaid ? paidAmount : 0,
                totalPlayerExpense,
                totalCsExpense,
                totalExpense,
                profit,
                refund: {
                    isRefunded: order.status === 'REFUNDED',
                    refundCompleted,
                    // 同 orders：暂按 paidAmount（且 isPaid 口径）作为退款金额口径（你没单独字段）
                    refundAmount: order.status === 'REFUNDED' ? (order.isPaid ? paidAmount : 0) : 0,
                },
            },
        };
    }

    async playerTransactions(
        reqUser: any,
        dto: { playerId: number; startAt?: string; endAt?: string; page?: number; pageSize?: number },
        req?: any,
    ) {
        this.ensureFinanceAccess(reqUser);
        const operatorId = this.getReqUserId(reqUser);

        const playerId = Number(dto.playerId);
        if (!Number.isFinite(playerId) || playerId <= 0) throw new BadRequestException('playerId 必填');

        const page = Math.max(1, Number(dto.page ?? 1));
        const pageSize = Math.min(100, Math.max(1, Number(dto.pageSize ?? 20)));
        const skip = (page - 1) * pageSize;

        const where: any = { userId: playerId };
        if (dto.startAt && dto.endAt) {
            where.createdAt = {
                gte: this.parseDateOrThrow(dto.startAt, 'startAt'),
                lte: this.parseDateOrThrow(dto.endAt, 'endAt'),
            };
        }

        const [total, data] = await this.prisma.$transaction([
            this.prisma.walletTransaction.count({ where }),
            this.prisma.walletTransaction.findMany({
                where,
                orderBy: { id: 'desc' },
                skip,
                take: pageSize,
                select: {
                    id: true,
                    userId: true,
                    direction: true,
                    bizType: true,
                    amount: true,
                    status: true,
                    orderId: true,
                    settlementId: true,
                    sourceType: true,
                    sourceId: true,
                    reversalOfTxId: true,
                    availableAfter: true,
                    frozenAfter: true,
                    createdAt: true,
                },
            }),
        ]);

        await this.writeUserLog({
            userId: operatorId,
            action: 'FINANCE_PLAYER_TRANSACTIONS',
            remark: '财务核账-打手流水查询',
            newData: {
                playerId,
                startAt: dto.startAt ?? null,
                endAt: dto.endAt ?? null,
                page,
                pageSize,
            },
            req,
        });

        return {
            page,
            pageSize,
            total,
            data: data.map((t) => ({
                ...t,
                amount: this.toNumber(t.amount),
                availableAfter: this.toNumber(t.availableAfter),
                frozenAfter: this.toNumber(t.frozenAfter),
            })),
        };
    }
}
