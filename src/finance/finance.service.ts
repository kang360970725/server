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

    private toDateStr(date: Date | string) {
        const d = new Date(date);
        const y = d.getFullYear();
        const m = `${d.getMonth() + 1}`.padStart(2, '0');
        const day = `${d.getDate()}`.padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    private buildPaymentRange(params: { startDate?: string; endDate?: string; date?: string }) {
        if (params.date) {
            return {
                startAt: new Date(`${params.date}T00:00:00.000+08:00`),
                endAt: new Date(`${params.date}T23:59:59.999+08:00`),
            };
        }

        const now = new Date();
        const startAt = params.startDate
            ? new Date(`${params.startDate}T00:00:00.000+08:00`)
            : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const endAt = params.endDate
            ? new Date(`${params.endDate}T23:59:59.999+08:00`)
            : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

        return { startAt, endAt };
    }

    private getOrderSourceLabel(orderSource?: string | null) {
        const code = String(orderSource || '').trim() || 'CUSTOMER_SERVICE_MANUAL';
        const labelMap: Record<string, string> = {
            TUTU_PLATFORM: '突突平台',
            THIRD_PARTY_TRANSFER: '第三方转单',
            MINIAPP_SELF_SERVICE: '小程序自助下单',
            CUSTOMER_SERVICE_MANUAL: '客服手动派单',
            OFFICIAL_ACCOUNT: '公众号下单',
        };
        return labelMap[code] || code;
    }

    private getUserTypeLabel(userType?: string | null) {
        const code = String(userType || '').trim().toUpperCase();
        const labelMap: Record<string, string> = {
            SUPER_ADMIN: '超级管理员',
            ADMIN: '管理管理员',
            STAFF: '员工',
            CUSTOMER_SERVICE: '客服',
            OPERATION: '运营',
            FINANCE: '财务',
            REGISTERED_USER: '普通用户',
        };
        return labelMap[code] || code || '未知';
    }

    private getDispatcherLabel(dispatcher?: { name?: string | null; userType?: string | null } | null) {
        const name = String(dispatcher?.name || '').trim() || '未指定';
        const userTypeLabel = this.getUserTypeLabel(dispatcher?.userType || null);
        return `${name}(${userTypeLabel})`;
    }

    private getCashAmount(order: any) {
        if (order?.isGifted) return 0;
        return this.round2(Number(order?.paidAmount ?? 0));
    }

    private isManualReceiptSource(orderSource?: string | null) {
        const source = String(orderSource || '').trim() || 'CUSTOMER_SERVICE_MANUAL';
        return source !== 'MINIAPP_SELF_SERVICE';
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

    async dashboardDailyOverview(dto: { startDate?: string; endDate?: string }) {
        const { startAt, endAt } = this.buildPaymentRange(dto);
        const rows = await this.prisma.order.findMany({
            where: {
                paymentTime: { gte: startAt, lte: endAt },
                isPaid: true,
            },
            select: {
                id: true,
                orderSource: true,
                isGifted: true,
                receivableAmount: true,
                paidAmount: true,
                paymentTime: true,
            },
            orderBy: { paymentTime: 'asc' },
        });

        const dayMap = new Map<
            string,
            {
                axis: string;
                orderCount: number;
                receivableAmountTotal: number;
                paidAmountTotal: number;
                settlementBaseAmountTotal: number;
                grossProfitAmountTotal: number;
                sourceMap: Map<
                    string,
                    {
                        source: string;
                        label: string;
                        orderCount: number;
                        receivableAmount: number;
                        paidAmount: number;
                        settlementBaseAmount: number;
                        grossProfitAmount: number;
                    }
                >;
            }
        >();

        for (const row of rows) {
            const axis = this.toDateStr(row.paymentTime || new Date());
            const source = String(row.orderSource || '').trim() || 'CUSTOMER_SERVICE_MANUAL';
            const label = this.getOrderSourceLabel(source);
            const cashAmount = this.getCashAmount(row);
            const receivableAmount = this.round2(Number(row.receivableAmount ?? 0));
            const settlementBaseAmount = this.round2(receivableAmount);
            const grossProfitAmount = this.round2(cashAmount - settlementBaseAmount);

            if (!dayMap.has(axis)) {
                dayMap.set(axis, {
                    axis,
                    orderCount: 0,
                    receivableAmountTotal: 0,
                    paidAmountTotal: 0,
                    settlementBaseAmountTotal: 0,
                    grossProfitAmountTotal: 0,
                    sourceMap: new Map(),
                });
            }

            const bucket = dayMap.get(axis)!;
            bucket.orderCount += 1;
            bucket.receivableAmountTotal = this.round2(bucket.receivableAmountTotal + receivableAmount);
            bucket.paidAmountTotal = this.round2(bucket.paidAmountTotal + cashAmount);
            bucket.settlementBaseAmountTotal = this.round2(bucket.settlementBaseAmountTotal + settlementBaseAmount);
            bucket.grossProfitAmountTotal = this.round2(bucket.grossProfitAmountTotal + grossProfitAmount);

            if (!bucket.sourceMap.has(source)) {
                bucket.sourceMap.set(source, {
                    source,
                    label,
                    orderCount: 0,
                    receivableAmount: 0,
                    paidAmount: 0,
                    settlementBaseAmount: 0,
                    grossProfitAmount: 0,
                });
            }

            const sourceBucket = bucket.sourceMap.get(source)!;
            sourceBucket.orderCount += 1;
            sourceBucket.receivableAmount = this.round2(sourceBucket.receivableAmount + receivableAmount);
            sourceBucket.paidAmount = this.round2(sourceBucket.paidAmount + cashAmount);
            sourceBucket.settlementBaseAmount = this.round2(sourceBucket.settlementBaseAmount + settlementBaseAmount);
            sourceBucket.grossProfitAmount = this.round2(sourceBucket.grossProfitAmount + grossProfitAmount);
        }

        const dailyRows = Array.from(dayMap.values())
            .sort((a, b) => a.axis.localeCompare(b.axis))
            .map((item) => ({
                axis: item.axis,
                orderCount: item.orderCount,
                receivableAmountTotal: this.round2(item.receivableAmountTotal),
                paidAmountTotal: this.round2(item.paidAmountTotal),
                settlementBaseAmountTotal: this.round2(item.settlementBaseAmountTotal),
                grossProfitAmountTotal: this.round2(item.grossProfitAmountTotal),
                sourceItems: Array.from(item.sourceMap.values())
                    .sort((a, b) => b.paidAmount - a.paidAmount)
                    .map((source) => ({
                        ...source,
                        receivableAmount: this.round2(source.receivableAmount),
                        paidAmount: this.round2(source.paidAmount),
                        settlementBaseAmount: this.round2(source.settlementBaseAmount),
                        grossProfitAmount: this.round2(source.grossProfitAmount),
                    })),
            }));

        const summary = dailyRows.reduce(
            (acc, row) => {
                acc.orderCount += row.orderCount;
                acc.receivableAmountTotal = this.round2(acc.receivableAmountTotal + row.receivableAmountTotal);
                acc.paidAmountTotal = this.round2(acc.paidAmountTotal + row.paidAmountTotal);
                acc.settlementBaseAmountTotal = this.round2(
                    acc.settlementBaseAmountTotal + row.settlementBaseAmountTotal,
                );
                acc.grossProfitAmountTotal = this.round2(acc.grossProfitAmountTotal + row.grossProfitAmountTotal);
                return acc;
            },
            {
                orderCount: 0,
                receivableAmountTotal: 0,
                paidAmountTotal: 0,
                settlementBaseAmountTotal: 0,
                grossProfitAmountTotal: 0,
            },
        );

        return {
            success: true,
            data: {
                range: {
                    startDate: this.toDateStr(startAt),
                    endDate: this.toDateStr(endAt),
                },
                rows: dailyRows,
                summary,
            },
        };
    }

    async dashboardShiftOverview(dto: { date: string; dispatcherId?: number; currentOrderId?: number }) {
        if (!dto?.date) {
            return {
                success: true,
                data: {
                    date: '',
                    currentDispatcherOrderCount: 0,
                    currentDispatcherPaidAmount: 0,
                    currentDispatcherSourceItems: [],
                    otherCsOrderCount: 0,
                    otherCsPaidAmount: 0,
                    otherCsSourceItems: [],
                    totalOrderCount: 0,
                    totalReceivableAmount: 0,
                    totalPaidAmount: 0,
                    wechatRealTimeAmount: 0,
                },
            };
        }

        const { startAt, endAt } = this.buildPaymentRange({ date: dto.date });
        const rows = await this.prisma.order.findMany({
            where: {
                paymentTime: { gte: startAt, lte: endAt },
                isPaid: true,
            },
            select: {
                id: true,
                orderSource: true,
                isGifted: true,
                receivableAmount: true,
                paidAmount: true,
                dispatcherId: true,
                dispatcher: {
                    select: {
                        id: true,
                        userType: true,
                    },
                },
            },
            orderBy: { paymentTime: 'asc' },
        });

        const manualSourceSet = new Set([
            'THIRD_PARTY_TRANSFER',
            'CUSTOMER_SERVICE_MANUAL',
            'OFFICIAL_ACCOUNT',
        ]);
        const isManualLike = (source: string) => manualSourceSet.has(source);

        const makeSourceBucket = () =>
            new Map<
                string,
                {
                    source: string;
                    label: string;
                    orderCount: number;
                    receivableAmount: number;
                    paidAmount: number;
                }
            >();

        const sourceAccum = (
            bucket: Map<
                string,
                {
                    source: string;
                    label: string;
                    orderCount: number;
                    receivableAmount: number;
                    paidAmount: number;
                }
            >,
            source: string,
            receivableAmount: number,
            paidAmount: number,
        ) => {
            const label = this.getOrderSourceLabel(source);
            if (!bucket.has(source)) {
                bucket.set(source, {
                    source,
                    label,
                    orderCount: 0,
                    receivableAmount: 0,
                    paidAmount: 0,
                });
            }
            const cur = bucket.get(source)!;
            cur.orderCount += 1;
            cur.receivableAmount = this.round2(cur.receivableAmount + receivableAmount);
            cur.paidAmount = this.round2(cur.paidAmount + paidAmount);
        };

        const currentDispatcherId = Number(dto.dispatcherId || 0) || null;
        let currentDispatcherOrderCount = 0;
        let currentDispatcherPaidAmount = 0;
        const currentDispatcherSourceMap = makeSourceBucket();

        let otherCsOrderCount = 0;
        let otherCsPaidAmount = 0;
        const otherCsSourceMap = makeSourceBucket();

        let totalOrderCount = 0;
        let totalReceivableAmount = 0;
        let totalPaidAmount = 0;
        let wechatRealTimeAmount = 0;

        for (const row of rows) {
            const source = String(row.orderSource || '').trim() || 'CUSTOMER_SERVICE_MANUAL';
            const receivableAmount = this.round2(Number(row.receivableAmount ?? 0));
            const paidAmount = this.getCashAmount(row);
            const settlementBaseAmount = this.round2(receivableAmount);
            const isManualLikeOrder = isManualLike(source);

            totalOrderCount += 1;
            totalReceivableAmount = this.round2(totalReceivableAmount + receivableAmount);
            totalPaidAmount = this.round2(totalPaidAmount + paidAmount);
            wechatRealTimeAmount = this.round2(wechatRealTimeAmount + paidAmount);

            const dispatcherId = Number(row.dispatcherId || 0) || null;
            const dispatcherType = String(row.dispatcher?.userType || '').trim();
            const isCustomerService = dispatcherType === 'CUSTOMER_SERVICE';

            if (currentDispatcherId && dispatcherId === currentDispatcherId && isManualLikeOrder) {
                currentDispatcherOrderCount += 1;
                currentDispatcherPaidAmount = this.round2(currentDispatcherPaidAmount + paidAmount);
                sourceAccum(currentDispatcherSourceMap, source, receivableAmount, paidAmount);
            } else if (isCustomerService && dispatcherId !== currentDispatcherId && isManualLikeOrder) {
                otherCsOrderCount += 1;
                otherCsPaidAmount = this.round2(otherCsPaidAmount + paidAmount);
                sourceAccum(otherCsSourceMap, source, receivableAmount, paidAmount);
            }
        }

        return {
            success: true,
            data: {
                date: dto.date,
                currentDispatcherOrderCount,
                currentDispatcherPaidAmount: this.round2(currentDispatcherPaidAmount),
                currentDispatcherSourceItems: Array.from(currentDispatcherSourceMap.values()),
                otherCsOrderCount,
                otherCsPaidAmount: this.round2(otherCsPaidAmount),
                otherCsSourceItems: Array.from(otherCsSourceMap.values()),
                totalOrderCount,
                totalReceivableAmount: this.round2(totalReceivableAmount),
                totalPaidAmount: this.round2(totalPaidAmount),
                wechatRealTimeAmount: this.round2(wechatRealTimeAmount),
            },
        };
    }

    async dashboardReconciliation(dto: { startDate?: string; endDate?: string }) {
        const { startAt, endAt } = this.buildPaymentRange(dto);
        const rows = await this.prisma.order.findMany({
            where: {
                paymentTime: { gte: startAt, lte: endAt },
                isPaid: true,
                isGifted: false,
            },
            select: {
                id: true,
                autoSerial: true,
                orderSource: true,
                receivableAmount: true,
                paidAmount: true,
                settlementBaseAmount: true,
                paymentTime: true,
                createdAt: true,
                updatedAt: true,
                dispatcherId: true,
                dispatcher: {
                    select: {
                        id: true,
                        name: true,
                        userType: true,
                    },
                },
            },
            orderBy: [{ paymentTime: 'asc' }, { id: 'asc' }],
        });

        const dayMap = new Map<
            string,
            {
                axis: string;
                allOrderCount: number;
                allPaidAmountTotal: number;
                manualReceiptOrderCount: number;
                manualReceiptAmountTotal: number;
                dispatcherMap: Map<
                    string,
                    {
                        dispatcherId: number | null;
                        dispatcherName: string;
                        dispatcherUserType: string;
                        orderCount: number;
                        paidAmountTotal: number;
                    }
                >;
                detailRows: Array<{
                    orderId: number;
                    autoSerial: string;
                    paymentTime: string;
                    paidAmount: number;
                    dispatcherLabel: string;
                    dispatcherUserType: string;
                    orderSource: string;
                    orderSourceLabel: string;
                }>;
            }
        >();

        let allOrderCount = 0;
        let allPaidAmountTotal = 0;
        let manualReceiptOrderCount = 0;
        let manualReceiptAmountTotal = 0;

        for (const row of rows) {
            const paymentAt = row.paymentTime || row.updatedAt || row.createdAt;
            if (!paymentAt) continue;

            const axis = this.toDateStr(paymentAt);
            const paidAmount = this.round2(Number(row.paidAmount ?? 0));
            const source = String(row.orderSource || '').trim() || 'CUSTOMER_SERVICE_MANUAL';
            const sourceLabel = this.getOrderSourceLabel(source);
            const dispatcherLabel = this.getDispatcherLabel(row.dispatcher as any);
            const dispatcherUserType = String(row.dispatcher?.userType || '').trim() || 'UNKNOWN';
            const dispatcherKey = String(row.dispatcherId || 0) || `dispatcher-${row.id}`;
            const isManualReceipt = this.isManualReceiptSource(source);

            allOrderCount += 1;
            allPaidAmountTotal = this.round2(allPaidAmountTotal + paidAmount);

            if (isManualReceipt) {
                manualReceiptOrderCount += 1;
                manualReceiptAmountTotal = this.round2(manualReceiptAmountTotal + paidAmount);
            }

            if (!isManualReceipt) {
                // 小程序自助单不纳入对账单明细
                continue;
            }

            if (!dayMap.has(axis)) {
                dayMap.set(axis, {
                    axis,
                    allOrderCount: 0,
                    allPaidAmountTotal: 0,
                    manualReceiptOrderCount: 0,
                    manualReceiptAmountTotal: 0,
                    dispatcherMap: new Map(),
                    detailRows: [],
                });
            }

            const bucket = dayMap.get(axis)!;
            bucket.allOrderCount += 1;
            bucket.allPaidAmountTotal = this.round2(bucket.allPaidAmountTotal + paidAmount);
            bucket.manualReceiptOrderCount += 1;
            bucket.manualReceiptAmountTotal = this.round2(bucket.manualReceiptAmountTotal + paidAmount);

            if (!bucket.dispatcherMap.has(dispatcherKey)) {
                bucket.dispatcherMap.set(dispatcherKey, {
                    dispatcherId: row.dispatcherId ?? null,
                    dispatcherName: String(row.dispatcher?.name || '未指定').trim() || '未指定',
                    dispatcherUserType,
                    orderCount: 0,
                    paidAmountTotal: 0,
                });
            }

            const dispatcherBucket = bucket.dispatcherMap.get(dispatcherKey)!;
            dispatcherBucket.orderCount += 1;
            dispatcherBucket.paidAmountTotal = this.round2(dispatcherBucket.paidAmountTotal + paidAmount);

            bucket.detailRows.push({
                orderId: Number(row.id),
                autoSerial: String(row.autoSerial || ''),
                paymentTime: paymentAt instanceof Date ? paymentAt.toISOString() : new Date(paymentAt).toISOString(),
                paidAmount,
                dispatcherLabel,
                dispatcherUserType,
                orderSource: source,
                orderSourceLabel: sourceLabel,
            });
        }

        const dailyRows = Array.from(dayMap.values())
            .sort((a, b) => a.axis.localeCompare(b.axis))
            .map((item) => ({
                axis: item.axis,
                allOrderCount: item.allOrderCount,
                allPaidAmountTotal: this.round2(item.allPaidAmountTotal),
                manualReceiptOrderCount: item.manualReceiptOrderCount,
                manualReceiptAmountTotal: this.round2(item.manualReceiptAmountTotal),
                dispatcherItems: Array.from(item.dispatcherMap.values())
                    .sort((a, b) => b.paidAmountTotal - a.paidAmountTotal)
                    .map((dispatcher) => ({
                        ...dispatcher,
                        paidAmountTotal: this.round2(dispatcher.paidAmountTotal),
                        dispatcherLabel: this.getDispatcherLabel({
                            name: dispatcher.dispatcherName,
                            userType: dispatcher.dispatcherUserType,
                        }),
                    })),
                detailRows: item.detailRows
                    .sort((a, b) => a.paymentTime.localeCompare(b.paymentTime))
                    .map((detail) => ({
                        ...detail,
                        paidAmount: this.round2(detail.paidAmount),
                    })),
            }));

        return {
            success: true,
            data: {
                range: {
                    startDate: this.toDateStr(startAt),
                    endDate: this.toDateStr(endAt),
                },
                summary: {
                    allOrderCount,
                    allPaidAmountTotal: this.round2(allPaidAmountTotal),
                    manualReceiptOrderCount,
                    manualReceiptAmountTotal: this.round2(manualReceiptAmountTotal),
                },
                rows: dailyRows,
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
}
