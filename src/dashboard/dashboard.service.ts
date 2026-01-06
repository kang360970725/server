import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
    constructor(private prisma: PrismaService) {}

    private parseRange(query: { startAt?: string; endAt?: string }) {
        const now = new Date();
        // 默认：今天（最符合看板直觉；你也可以改成本月）
        const startAt = query.startAt ? new Date(query.startAt) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const endAt = query.endAt ? new Date(query.endAt) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        return { startAt, endAt };
    }

    /**
     * 全平台营业额看板（实时聚合）
     * 时间口径：Order.createdAt / WalletTransaction.createdAt
     */
    async getRevenueOverview(query: { startAt?: string; endAt?: string }) {
        const { startAt, endAt } = this.parseRange(query);

        // 1) 营业额相关：排除赠送单
        const orderWhereBase: any = {
            createdAt: { gte: startAt, lte: endAt },
            isGifted: false,
        };

        const [ordersAgg, refundedAgg] = await Promise.all([
            this.prisma.order.aggregate({
                where: orderWhereBase,
                _count: { _all: true },
                _sum: { paidAmount: true },
            }),
            this.prisma.order.aggregate({
                where: { ...orderWhereBase, status: 'REFUNDED' },
                _count: { _all: true },
                _sum: { paidAmount: true },
            }),
        ]);

        const totalOrders = Number(ordersAgg._count?._all ?? 0);
        const totalRevenue = Number(ordersAgg._sum?.paidAmount ?? 0);

        const refundedOrders = Number(refundedAgg._count?._all ?? 0);
        const refundedAmount = Number(refundedAgg._sum?.paidAmount ?? 0);

        // 2) 成本预估：钱包收益流水（全量）
        const walletWhereBase: any = {
            createdAt: { gte: startAt, lte: endAt },
            direction: 'IN',
            bizType: 'SETTLEMENT_EARNING',
            status: { not: 'REVERSED' },
        };

        const totalCostAgg = await this.prisma.walletTransaction.aggregate({
            where: walletWhereBase,
            _sum: { amount: true },
        });
        const totalCostAll = Number(totalCostAgg._sum?.amount ?? 0);

        // 3) 赠送单成本：找出赠送订单 ID（同时间口径），再统计这些订单对应的钱包收益流水金额
        //   - 赠送单不计入营业额，也不应计入“成本预估/利润率”（按你业务直觉）
        const giftedOrders = await this.prisma.order.findMany({
            where: {
                createdAt: { gte: startAt, lte: endAt },
                isGifted: true,
            },
            select: { id: true },
        });

        let giftedCost = 0;

        if (giftedOrders.length > 0) {
            const giftedIds = giftedOrders.map((o) => o.id);

            // 防止 in(...) 太长：分批聚合（每批 1000）
            const chunkSize = 1000;
            for (let i = 0; i < giftedIds.length; i += chunkSize) {
                const chunk = giftedIds.slice(i, i + chunkSize);
                const agg = await this.prisma.walletTransaction.aggregate({
                    where: {
                        ...walletWhereBase,
                        orderId: { in: chunk },
                    },
                    _sum: { amount: true },
                });
                giftedCost += Number(agg._sum?.amount ?? 0);
            }
        }

        const cost = totalCostAll - giftedCost;

        // 4) 利润预估与利润率（注意分母为 0）
        const profit = totalRevenue - cost;
        const profitRate = totalRevenue > 0 ? profit / totalRevenue : 0;

        return {
            range: { startAt, endAt },

            totalOrders,
            totalRevenue,

            refundedOrders,
            refundedAmount,

            // 成本/利润（均已排除赠送单对应成本）
            costEstimated: Number(cost.toFixed(2)),
            profitEstimated: Number(profit.toFixed(2)),
            profitRate: Number((profitRate * 100).toFixed(2)), // 返回百分比数值，例如 12.34

            // 额外：赠送单成本（便于你后续单独看活动成本）
            giftedCost: Number(giftedCost.toFixed(2)),
        };
    }
}
