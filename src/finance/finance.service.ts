import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceDashboardSummaryDto } from './dto/finance-dashboard-summary.dto';
import { FinanceDashboardTrendDto } from './dto/finance-dashboard-trend.dto';
import { FinanceDashboardCostStructureDto } from './dto/finance-dashboard-cost-structure.dto';
import { FinanceRecordListDto } from './dto/finance-record-list.dto';

@Injectable()
export class FinanceService {
    constructor(private readonly prisma: PrismaService) {}

    private round2(val: any) {
        const n = Number(val ?? 0);
        if (!Number.isFinite(n)) return 0;
        return Math.round(n * 100) / 100;
    }

    private buildWhere(params: {
        startDate?: string;
        endDate?: string;
        billingMode?: string;
        orderType?: string;
        projectId?: number;
        bizLine?: string;
        customerUserId?: number;
        isComplained?: boolean;
        isAfterSale?: boolean;
        isCancelled?: boolean;
        status?: string;
    }) {
        const where: any = {};

        if (params.startDate || params.endDate) {
            where.statsDate = {};
            if (params.startDate) where.statsDate.gte = new Date(`${params.startDate}T00:00:00.000+08:00`);
            if (params.endDate) where.statsDate.lte = new Date(`${params.endDate}T23:59:59.999+08:00`);
        }

        if (params.billingMode) where.billingMode = params.billingMode;
        if (params.orderType) where.orderType = params.orderType;
        if (params.projectId) where.projectId = Number(params.projectId);
        if (params.bizLine) where.bizLine = params.bizLine;
        if (params.customerUserId) where.customerUserId = Number(params.customerUserId);

        if (typeof params.isComplained === 'boolean') where.isComplained = params.isComplained;
        if (typeof params.isAfterSale === 'boolean') where.isAfterSale = params.isAfterSale;
        if (typeof params.isCancelled === 'boolean') where.isCancelled = params.isCancelled;

        if (params.status) where.status = params.status;

        return where;
    }

    private formatSummary(agg: any, totalCount = 0) {
        const receivableAmountTotal = this.round2(agg?._sum?.receivableAmount);
        const paidAmountTotal = this.round2(agg?._sum?.paidAmount);

        const playerCostAmountTotal = this.round2(agg?._sum?.playerCostAmount);
        const csCostAmountTotal = this.round2(agg?._sum?.csCostAmount);
        const operationCostAmountTotal = this.round2(agg?._sum?.operationCostAmount);
        const channelCostAmountTotal = this.round2(agg?._sum?.channelCostAmount);

        const couponDiscountAmountTotal = this.round2(agg?._sum?.couponDiscountAmount);
        const otherDiscountAmountTotal = this.round2(agg?._sum?.otherDiscountAmount);
        const marketingCostTotal = this.round2(agg?._sum?.discountAmount);

        const afterSaleCostAmountTotal = this.round2(agg?._sum?.afterSaleCostAmount);
        const complaintPenaltyAmountTotal = this.round2(agg?._sum?.complaintPenaltyAmount);

        const grossProfitAmountTotal = this.round2(agg?._sum?.grossProfitAmount);

        const fulfillmentCostTotal = this.round2(
            playerCostAmountTotal +
            csCostAmountTotal +
            operationCostAmountTotal +
            channelCostAmountTotal,
        );

        const orderTotalCost = this.round2(
            fulfillmentCostTotal +
            marketingCostTotal +
            afterSaleCostAmountTotal +
            complaintPenaltyAmountTotal,
        );

        const grossProfitRate =
            paidAmountTotal > 0
                ? this.round2((grossProfitAmountTotal / paidAmountTotal) * 100)
                : 0;

        return {
            orderCount: Number(totalCount || 0),

            receivableAmountTotal,
            paidAmountTotal,

            playerCostAmountTotal,
            csCostAmountTotal,
            operationCostAmountTotal,
            channelCostAmountTotal,

            fulfillmentCostTotal,

            marketingCostTotal,
            couponDiscountAmountTotal,
            otherDiscountAmountTotal,

            afterSaleCostAmountTotal,
            complaintPenaltyAmountTotal,

            orderTotalCost,
            grossProfitAmountTotal,
            grossProfitRate,
        };
    }

    async dashboardSummary(dto: FinanceDashboardSummaryDto) {
        const where = this.buildWhere(dto);

        const [agg, total] = await this.prisma.$transaction([
            this.prisma.orderFinanceRecord.aggregate({
                where,
                _sum: {
                    receivableAmount: true,
                    paidAmount: true,

                    playerCostAmount: true,
                    csCostAmount: true,
                    operationCostAmount: true,
                    channelCostAmount: true,

                    discountAmount: true,
                    couponDiscountAmount: true,
                    otherDiscountAmount: true,

                    afterSaleCostAmount: true,
                    complaintPenaltyAmount: true,

                    grossProfitAmount: true,
                },
            }),
            this.prisma.orderFinanceRecord.count({ where }),
        ]);

        return {
            success: true,
            data: this.formatSummary(agg, total),
        };
    }

    async dashboardTrend(dto: FinanceDashboardTrendDto) {
        const where = this.buildWhere(dto);

        if (dto.groupBy === 'MONTH') {
            const rows = await this.prisma.orderFinanceRecord.groupBy({
                by: ['statsMonth'],
                where,
                _sum: {
                    receivableAmount: true,
                    paidAmount: true,

                    playerCostAmount: true,
                    csCostAmount: true,
                    operationCostAmount: true,
                    channelCostAmount: true,

                    discountAmount: true,
                    afterSaleCostAmount: true,
                    complaintPenaltyAmount: true,
                    grossProfitAmount: true,
                },
                _count: {
                    _all: true,
                },
                orderBy: {
                    statsMonth: 'asc',
                },
            });

            return {
                success: true,
                data: rows.map((item: any) => {
                    const playerCostAmountTotal = this.round2(item._sum?.playerCostAmount);
                    const csCostAmountTotal = this.round2(item._sum?.csCostAmount);
                    const operationCostAmountTotal = this.round2(item._sum?.operationCostAmount);
                    const channelCostAmountTotal = this.round2(item._sum?.channelCostAmount);

                    const fulfillmentCostTotal = this.round2(
                        playerCostAmountTotal +
                        csCostAmountTotal +
                        operationCostAmountTotal +
                        channelCostAmountTotal,
                    );

                    const marketingCostTotal = this.round2(item._sum?.discountAmount);
                    const afterSaleCostAmountTotal = this.round2(item._sum?.afterSaleCostAmount);
                    const complaintPenaltyAmountTotal = this.round2(item._sum?.complaintPenaltyAmount);

                    const orderTotalCost = this.round2(
                        fulfillmentCostTotal +
                        marketingCostTotal +
                        afterSaleCostAmountTotal +
                        complaintPenaltyAmountTotal,
                    );

                    return {
                        axis: item.statsMonth,
                        receivableAmountTotal: this.round2(item._sum?.receivableAmount),
                        paidAmountTotal: this.round2(item._sum?.paidAmount),

                        playerCostAmountTotal,
                        csCostAmountTotal,
                        operationCostAmountTotal,
                        channelCostAmountTotal,

                        fulfillmentCostTotal,
                        marketingCostTotal,
                        afterSaleCostAmountTotal,
                        complaintPenaltyAmountTotal,
                        orderTotalCost,
                        grossProfitAmountTotal: this.round2(item._sum?.grossProfitAmount),
                        orderCount: Number(item._count?._all || 0),
                    };
                }),
            };
        }

        const rows = await this.prisma.orderFinanceRecord.groupBy({
            by: ['statsDate'],
            where,
            _sum: {
                receivableAmount: true,
                paidAmount: true,

                playerCostAmount: true,
                csCostAmount: true,
                operationCostAmount: true,
                channelCostAmount: true,

                discountAmount: true,
                afterSaleCostAmount: true,
                complaintPenaltyAmount: true,
                grossProfitAmount: true,
            },
            _count: {
                _all: true,
            },
            orderBy: {
                statsDate: 'asc',
            },
        });

        return {
            success: true,
            data: rows.map((item: any) => {
                const playerCostAmountTotal = this.round2(item._sum?.playerCostAmount);
                const csCostAmountTotal = this.round2(item._sum?.csCostAmount);
                const operationCostAmountTotal = this.round2(item._sum?.operationCostAmount);
                const channelCostAmountTotal = this.round2(item._sum?.channelCostAmount);

                const fulfillmentCostTotal = this.round2(
                    playerCostAmountTotal +
                    csCostAmountTotal +
                    operationCostAmountTotal +
                    channelCostAmountTotal,
                );

                const marketingCostTotal = this.round2(item._sum?.discountAmount);
                const afterSaleCostAmountTotal = this.round2(item._sum?.afterSaleCostAmount);
                const complaintPenaltyAmountTotal = this.round2(item._sum?.complaintPenaltyAmount);

                const orderTotalCost = this.round2(
                    fulfillmentCostTotal +
                    marketingCostTotal +
                    afterSaleCostAmountTotal +
                    complaintPenaltyAmountTotal,
                );

                return {
                    axis: this.toDateStr(item.statsDate),
                    receivableAmountTotal: this.round2(item._sum?.receivableAmount),
                    paidAmountTotal: this.round2(item._sum?.paidAmount),

                    playerCostAmountTotal,
                    csCostAmountTotal,
                    operationCostAmountTotal,
                    channelCostAmountTotal,

                    fulfillmentCostTotal,
                    marketingCostTotal,
                    afterSaleCostAmountTotal,
                    complaintPenaltyAmountTotal,
                    orderTotalCost,
                    grossProfitAmountTotal: this.round2(item._sum?.grossProfitAmount),
                    orderCount: Number(item._count?._all || 0),
                };
            }),
        };
    }

    async dashboardCostStructure(dto: FinanceDashboardCostStructureDto) {
        const where = this.buildWhere(dto);

        const agg = await this.prisma.orderFinanceRecord.aggregate({
            where,
            _sum: {
                playerCostAmount: true,
                csCostAmount: true,
                operationCostAmount: true,
                channelCostAmount: true,
                discountAmount: true,
                afterSaleCostAmount: true,
                complaintPenaltyAmount: true,
            },
        });

        const items = [
            {
                type: 'PLAYER_COST',
                name: '打手成本',
                amount: this.round2(agg._sum?.playerCostAmount),
            },
            {
                type: 'CS_COST',
                name: '客服成本',
                amount: this.round2(agg._sum?.csCostAmount),
            },
            {
                type: 'OPERATION_COST',
                name: '运营成本',
                amount: this.round2(agg._sum?.operationCostAmount),
            },
            {
                type: 'CHANNEL_COST',
                name: '渠道成本',
                amount: this.round2(agg._sum?.channelCostAmount),
            },
            {
                type: 'MARKETING_COST',
                name: '营销成本',
                amount: this.round2(agg._sum?.discountAmount),
            },
            {
                type: 'AFTER_SALE_COST',
                name: '售后成本',
                amount: this.round2(agg._sum?.afterSaleCostAmount),
            },
            {
                type: 'COMPLAINT_COST',
                name: '赔付成本',
                amount: this.round2(agg._sum?.complaintPenaltyAmount),
            },
        ];

        return {
            success: true,
            data: {
                items,
            },
        };
    }

    async recordsList(dto: FinanceRecordListDto) {
        const page = Math.max(1, Number(dto.page || 1));
        const pageSize = Math.min(200, Math.max(1, Number(dto.pageSize || 20)));
        const skip = (page - 1) * pageSize;

        const where = this.buildWhere(dto);

        const [list, total, agg] = await this.prisma.$transaction([
            this.prisma.orderFinanceRecord.findMany({
                where,
                skip,
                take: pageSize,
                orderBy: [{ statsDate: 'desc' }, { id: 'desc' }],
            }),
            this.prisma.orderFinanceRecord.count({ where }),
            this.prisma.orderFinanceRecord.aggregate({
                where,
                _sum: {
                    receivableAmount: true,
                    paidAmount: true,

                    playerCostAmount: true,
                    csCostAmount: true,
                    operationCostAmount: true,
                    channelCostAmount: true,

                    discountAmount: true,
                    couponDiscountAmount: true,
                    otherDiscountAmount: true,

                    afterSaleCostAmount: true,
                    complaintPenaltyAmount: true,

                    grossProfitAmount: true,
                },
            }),
        ]);

        return {
            success: true,
            data: {
                list: list.map((item: any) => ({
                    ...item,
                    statsDate: this.toDateStr(item.statsDate),
                    createdAt: item.createdAt,
                    updatedAt: item.updatedAt,
                })),
                total,
                page,
                pageSize,
                summary: this.formatSummary(agg, total),
            },
        };
    }

    private toDateStr(date: Date | string) {
        const d = new Date(date);
        const y = d.getFullYear();
        const m = `${d.getMonth() + 1}`.padStart(2, '0');
        const day = `${d.getDate()}`.padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
}