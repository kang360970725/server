import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PerformanceDashboardOverviewDto } from './dto/performance-dashboard-overview.dto';
import { PerformanceDashboardListDto } from './dto/performance-dashboard-list.dto';

@Injectable()
export class PerformanceService {
    constructor(private readonly prisma: PrismaService) {}

    private readonly WITHDRAW_SUCCESS_STATUSES: string[] = ['PAID'];

    async dashboardOverview(dto: PerformanceDashboardOverviewDto) {
        const wherePack = this.buildWherePack(dto);

        const [summary, trend, incomeComposition, ranking] = await Promise.all([
            this.computeOverviewSummary(wherePack),
            this.computeOverviewTrend(wherePack),
            this.computeIncomeComposition(wherePack),
            this.computeOverviewRanking(wherePack),
        ]);

        return {
            summary,
            trend,
            incomeComposition,
            ranking,
        };
    }

    async dashboardList(dto: PerformanceDashboardListDto) {
        const page = Math.max(1, Number(dto.page || 1));
        const limit = Math.max(1, Math.min(Number(dto.limit || 20), 100));

        const wherePack = this.buildWherePack(dto);
        const fullRows = await this.computeDashboardListRows(wherePack);
        const sortedRows = this.sortDashboardRows(fullRows, dto.sortField, dto.sortOrder);

        const total = sortedRows.length;
        const start = (page - 1) * limit;
        const data = sortedRows.slice(start, start + limit);

        return {
            data,
            total,
            page,
            limit,
            footerSummary: {
                totalGrossPerformanceAmount: this.round2(
                    sortedRows.reduce((sum, row) => sum + Number(row.grossPerformanceAmount || 0), 0),
                ),
                totalNetIncomeAmount: this.round2(
                    sortedRows.reduce((sum, row) => sum + Number(row.netIncomeAmount || 0), 0),
                ),
                totalContributionAmount: this.round2(
                    sortedRows.reduce((sum, row) => sum + Number(row.totalContributionAmount || 0), 0),
                ),
                totalNegativeIncomeAmount: this.round2(
                    sortedRows.reduce((sum, row) => sum + Number(row.negativeIncomeAmount || 0), 0),
                ),
                totalWithdrawSuccess: this.round2(
                    sortedRows.reduce((sum, row) => sum + Number(row.withdrawSuccessAmount || 0), 0),
                ),
                totalWalletAvailable: this.round2(
                    sortedRows.reduce((sum, row) => sum + Number(row.walletAvailable || 0), 0),
                ),
                totalWalletFrozen: this.round2(
                    sortedRows.reduce((sum, row) => sum + Number(row.walletFrozen || 0), 0),
                ),
                totalCompletedOrders: sortedRows.reduce(
                    (sum, row) => sum + Number(row.completedOrders || 0),
                    0,
                ),
            },
        };
    }

    private buildWherePack(dto: {
        dateFrom?: string;
        dateTo?: string;
        billingMode?: 'HOURLY' | 'GUARANTEED' | 'MODE_PLAY';
        userType?: 'STAFF' | 'CUSTOMER_SERVICE' | 'ALL';
        keyword?: string;
    }) {
        const { dateFrom, dateTo, billingMode, userType, keyword } = dto;

        const perfWhere: any = {
            status: 'EFFECTIVE',
        };
        const userWhere: any = {};
        const walletAccountWhere: any = {};
        const withdrawalWhere: any = {};

        if (dateFrom || dateTo) {
            perfWhere.statsDate = {};
            withdrawalWhere.createdAt = {};

            if (dateFrom) {
                const from = new Date(`${dateFrom} 00:00:00`);
                perfWhere.statsDate.gte = from;
                withdrawalWhere.createdAt.gte = from;
            }

            if (dateTo) {
                const to = new Date(`${dateTo} 23:59:59`);
                perfWhere.statsDate.lte = to;
                withdrawalWhere.createdAt.lte = to;
            }
        }

        if (billingMode) {
            perfWhere.billingMode = billingMode;
        }

        if (userType && userType !== 'ALL') {
            userWhere.userType = userType;
        }

        if (keyword) {
            userWhere.OR = [
                { name: { contains: keyword } },
                { phone: { contains: keyword } },
                ...(Number(keyword) ? [{ id: Number(keyword) }] : []),
            ];
        }

        if (Object.keys(userWhere).length) {
            walletAccountWhere.user = userWhere;
            withdrawalWhere.user = userWhere;
        }

        return {
            perfWhere,
            userWhere,
            walletAccountWhere,
            withdrawalWhere,
        };
    }

    private async computeOverviewSummary(wherePack: any) {
        const [records, walletAccounts, withdrawals] = await Promise.all([
            this.prisma.performanceRecord.findMany({
                where: wherePack.perfWhere,
                select: {
                    ownerUserId: true,
                    ownerRoleType: true,
                    orderId: true,
                    statsDate: true,
                    grossPerformanceAmount: true,
                    netIncomeAmount: true,
                    negativeIncomeAmount: true,
                },
            }),
            this.prisma.walletAccount.findMany({
                where: wherePack.walletAccountWhere,
                select: {
                    userId: true,
                    availableBalance: true,
                    frozenBalance: true,
                },
            }),
            this.prisma.walletWithdrawalRequest.findMany({
                where: {
                    ...wherePack.withdrawalWhere,
                    status: {
                        in: this.WITHDRAW_SUCCESS_STATUSES as any,
                    },
                },
                select: {
                    userId: true,
                    amount: true,
                },
            }),
        ]);

        let totalGrossPerformanceAmount = 0;
        let totalNetIncomeAmount = 0;
        let totalNegativeIncomeAmount = 0;
        let totalContributionAmount = 0;

        let playerGrossPerformanceAmount = 0;
        let playerNetIncomeAmount = 0;

        let csGrossPerformanceAmount = 0;
        let csNetIncomeAmount = 0;

        records.forEach((item) => {
            const gross = Number(item.grossPerformanceAmount || 0);
            const net = Number(item.netIncomeAmount || 0);
            const negative = Number(item.negativeIncomeAmount || 0);
            const role = String(item.ownerRoleType || '');

            totalGrossPerformanceAmount += gross;
            totalNetIncomeAmount += net;
            totalNegativeIncomeAmount += negative;

            if (role === 'PLAYER') {
                playerGrossPerformanceAmount += gross;
                playerNetIncomeAmount += net;
                totalContributionAmount += gross - net;
            } else if (role === 'CS') {
                csGrossPerformanceAmount += gross;
                csNetIncomeAmount += net;
            }
        });

        const orderSet = new Set(records.map((item) => Number(item.orderId || 0)).filter(Boolean));

        const playerUserSet = new Set(
            records
                .filter((item) => item.ownerRoleType === 'PLAYER')
                .map((item) => Number(item.ownerUserId || 0))
                .filter(Boolean),
        );

        const csUserSet = new Set(
            records
                .filter((item) => item.ownerRoleType === 'CS')
                .map((item) => Number(item.ownerUserId || 0))
                .filter(Boolean),
        );

        const walletAvailable = walletAccounts.reduce(
            (sum, item) => sum + Number(item.availableBalance || 0),
            0,
        );
        const walletFrozen = walletAccounts.reduce(
            (sum, item) => sum + Number(item.frozenBalance || 0),
            0,
        );

        const withdrawSuccessAmount = withdrawals.reduce(
            (sum, item) => sum + Number(item.amount || 0),
            0,
        );

        const todayRange = this.getTodayRange();
        const todayNetIncome = records
            .filter((item) => {
                const t = new Date(item.statsDate).getTime();
                return t >= todayRange.start.getTime() && t <= todayRange.end.getTime();
            })
            .reduce((sum, item) => sum + Number(item.netIncomeAmount || 0), 0);

        return {
            totalGrossPerformanceAmount: this.round2(totalGrossPerformanceAmount),
            totalNetIncomeAmount: this.round2(totalNetIncomeAmount),
            totalContributionAmount: this.round2(totalContributionAmount),
            totalNegativeIncomeAmount: this.round2(totalNegativeIncomeAmount),

            playerGrossPerformanceAmount: this.round2(playerGrossPerformanceAmount),
            playerNetIncomeAmount: this.round2(playerNetIncomeAmount),

            csGrossPerformanceAmount: this.round2(csGrossPerformanceAmount),
            csNetIncomeAmount: this.round2(csNetIncomeAmount),

            totalCompletedOrders: orderSet.size,
            activeEarners: playerUserSet.size,
            activeCsUsers: csUserSet.size,
            avgNetIncomePerUser: this.round2(playerUserSet.size ? playerNetIncomeAmount / playerUserSet.size : 0),
            totalWithdrawSuccessAmount: this.round2(withdrawSuccessAmount),
            currentWalletAvailable: this.round2(walletAvailable),
            currentWalletFrozen: this.round2(walletFrozen),
            todayNetIncomeAmount: this.round2(todayNetIncome),
        };
    }


    private async computeOverviewTrend(wherePack: any) {
        const records = await this.prisma.performanceRecord.findMany({
            where: wherePack.perfWhere,
            select: {
                ownerUserId: true,
                orderId: true,
                ownerRoleType: true,
                statsDate: true,
                grossPerformanceAmount: true,
                netIncomeAmount: true,
                negativeIncomeAmount: true,
            },
            orderBy: {
                statsDate: 'asc',
            },
        });

        const dates =
            records.length > 0
                ? Array.from(new Set(records.map((item) => this.formatDate(item.statsDate)))).sort()
                : this.buildDateSeriesFromPerfWhere(wherePack);

        const map = new Map<
            string,
            {
                date: string;
                grossPerformanceAmount: number;
                netIncomeAmount: number;
                negativeIncomeAmount: number;
                orderSet: Set<number>;
                userSet: Set<number>;
            }
        >();

        dates.forEach((date) => {
            map.set(date, {
                date,
                grossPerformanceAmount: 0,
                netIncomeAmount: 0,
                negativeIncomeAmount: 0,
                orderSet: new Set<number>(),
                userSet: new Set<number>(),
            });
        });

        records.forEach((item) => {
            const date = this.formatDate(item.statsDate);
            const row = map.get(date);
            if (!row) return;
            const role = String(item.ownerRoleType || '');
            if (role !== 'PLAYER')  return;

            row.grossPerformanceAmount += Number(item.grossPerformanceAmount || 0);
            row.netIncomeAmount += Number(item.netIncomeAmount || 0);
            row.negativeIncomeAmount += Number(item.negativeIncomeAmount || 0);
            if (item.orderId) row.orderSet.add(Number(item.orderId));
            if (item.ownerUserId) row.userSet.add(Number(item.ownerUserId));
        });

        return Array.from(map.values())
            .sort((a, b) => (a.date < b.date ? 1 : -1))
            .map((item) => ({
                date: item.date,
                grossPerformanceAmount: this.round2(item.grossPerformanceAmount),
                netIncomeAmount: this.round2(item.netIncomeAmount),
                negativeIncomeAmount: this.round2(item.negativeIncomeAmount),
                completedOrders: item.orderSet.size,
                activeUsers: item.userSet.size,
            }));
    }

    private async computeIncomeComposition(wherePack: any) {
        const records = await this.prisma.performanceRecord.findMany({
            where: wherePack.perfWhere,
            select: {
                ownerRoleType: true,
                billingMode: true,
                netIncomeAmount: true,
            },
        });

        let hourlyIncome = 0;
        let guaranteedIncome = 0;
        let modePlayIncome = 0;
        let otherIncome = 0;
        let csIncome = 0;

        records.forEach((item) => {
            const amount = Number(item.netIncomeAmount || 0);
            const role = String(item.ownerRoleType || '');

            if (role === 'CS') {
                csIncome += amount;
                return;
            }

            if (item.billingMode === 'HOURLY') {
                hourlyIncome += amount;
            } else if (item.billingMode === 'GUARANTEED') {
                guaranteedIncome += amount;
            } else if (item.billingMode === 'MODE_PLAY') {
                modePlayIncome += amount;
            } else {
                otherIncome += amount;
            }
        });

        return {
            hourlyIncome: this.round2(hourlyIncome),
            guaranteedIncome: this.round2(guaranteedIncome),
            modePlayIncome: this.round2(modePlayIncome),
            carryIncome: 0,
            csIncome: this.round2(csIncome),
            otherIncome: this.round2(otherIncome),
        };
    }


    private async computeOverviewRanking(wherePack: any) {
        const [records, users, withdrawals] = await Promise.all([
            this.prisma.performanceRecord.findMany({
                where: wherePack.perfWhere,
                select: {
                    ownerUserId: true,
                    ownerRoleType: true,
                    orderId: true,
                    grossPerformanceAmount: true,
                    netIncomeAmount: true,
                },
            }),
            this.prisma.user.findMany({
                where: wherePack.userWhere,
                select: {
                    id: true,
                    name: true,
                },
            }),
            this.prisma.walletWithdrawalRequest.findMany({
                where: {
                    ...wherePack.withdrawalWhere,
                    status: {
                        in: this.WITHDRAW_SUCCESS_STATUSES as any,
                    },
                },
                select: {
                    userId: true,
                    amount: true,
                },
            }),
        ]);

        const userNameMap = new Map<number, string>();
        users.forEach((u) => userNameMap.set(Number(u.id), u.name || `用户${u.id}`));

        const perfMap = new Map<
            number,
            {
                userId: number;
                grossPerformanceAmount: number;
                netIncomeAmount: number;
                orderSet: Set<number>;
            }
        >();

        records.forEach((item) => {
            const userId = Number(item.ownerUserId || 0);
            if (!userId) return;
            const role = String(item.ownerRoleType || '');
            if (role !== 'PLAYER')  return;

            if (!perfMap.has(userId)) {
                perfMap.set(userId, {
                    userId,
                    grossPerformanceAmount: 0,
                    netIncomeAmount: 0,
                    orderSet: new Set<number>(),
                });
            }

            const row = perfMap.get(userId)!;
            row.grossPerformanceAmount += Number(item.grossPerformanceAmount || 0);
            row.netIncomeAmount += Number(item.netIncomeAmount || 0);
            if (item.orderId) row.orderSet.add(Number(item.orderId));
        });

        const incomeTop = Array.from(perfMap.values())
            .sort((a, b) => b.netIncomeAmount - a.netIncomeAmount)
            .slice(0, 10)
            .map((item) => ({
                userId: item.userId,
                userName: userNameMap.get(item.userId) || `用户${item.userId}`,
                amount: this.round2(item.netIncomeAmount),
                completedOrders: item.orderSet.size,
            }));

        const orderTop = Array.from(perfMap.values())
            .sort((a, b) => b.orderSet.size - a.orderSet.size)
            .slice(0, 10)
            .map((item) => ({
                userId: item.userId,
                userName: userNameMap.get(item.userId) || `用户${item.userId}`,
                completedOrders: item.orderSet.size,
                amount: this.round2(item.netIncomeAmount),
            }));

        const withdrawMap = new Map<number, { userId: number; amount: number; successCount: number }>();

        withdrawals.forEach((item) => {
            const userId = Number(item.userId || 0);
            if (!userId) return;
            if (!withdrawMap.has(userId)) {
                withdrawMap.set(userId, {
                    userId,
                    amount: 0,
                    successCount: 0,
                });
            }

            const row = withdrawMap.get(userId)!;
            row.amount += Number(item.amount || 0);
            row.successCount += 1;
        });

        const withdrawTop = Array.from(withdrawMap.values())
            .sort((a, b) => b.amount - a.amount)
            .slice(0, 10)
            .map((item) => ({
                userId: item.userId,
                userName: userNameMap.get(item.userId) || `用户${item.userId}`,
                amount: this.round2(item.amount),
                successCount: item.successCount,
            }));

        return {
            incomeTop,
            orderTop,
            withdrawTop,
        };
    }

    private async computeDashboardListRows(wherePack: any) {
        const [users, records, walletAccounts, withdrawals] = await Promise.all([
            this.prisma.user.findMany({
                where: wherePack.userWhere,
                select: {
                    id: true,
                    name: true,
                    phone: true,
                    avatar: true,
                    userType: true,
                    canWithdraw: true,
                    staffRating: {
                        select: {
                            name: true,
                        },
                    },
                },
            }),
            this.prisma.performanceRecord.findMany({
                where: wherePack.perfWhere,
                select: {
                    ownerUserId: true,
                    ownerRoleType: true,
                    orderId: true,
                    dispatchId: true,
                    billingMode: true,
                    grossPerformanceAmount: true,
                    netIncomeAmount: true,
                    negativeIncomeAmount: true,
                    statsDate: true,
                },
            }),
            this.prisma.walletAccount.findMany({
                where: wherePack.walletAccountWhere,
                select: {
                    userId: true,
                    availableBalance: true,
                    frozenBalance: true,
                },
            }),
            this.prisma.walletWithdrawalRequest.findMany({
                where: {
                    ...wherePack.withdrawalWhere,
                    status: {
                        in: this.WITHDRAW_SUCCESS_STATUSES as any,
                    },
                },
                select: {
                    userId: true,
                    amount: true,
                },
            }),
        ]);

        const userMap = new Map<number, any>();

        users.forEach((u) => {
            userMap.set(Number(u.id), {
                userId: Number(u.id),
                userName: u.name || `用户${u.id}`,
                phone: u.phone || '',
                avatar: u.avatar || '',
                userType: u.userType || '',
                canWithdraw: !!u.canWithdraw,
                staffRatingName: u.staffRating?.name || '',
                ownerRoleType: '',
                completedOrderSet: new Set<number>(),
                dispatchSet: new Set<number>(),
                grossPerformanceAmount: 0,
                netIncomeAmount: 0,
                totalContributionAmount: 0,
                negativeIncomeAmount: 0,
                hourlyIncome: 0,
                guaranteedIncome: 0,
                modePlayIncome: 0,
                otherIncome: 0,
                csIncome: 0,
                withdrawSuccessAmount: 0,
                walletAvailable: 0,
                walletFrozen: 0,
                walletTotal: 0,
                lastStatsDate: null as Date | null,
            });
        });

        records.forEach((item) => {
            const userId = Number(item.ownerUserId || 0);
            if (!userId) return;

            if (!userMap.has(userId)) {
                userMap.set(userId, {
                    userId,
                    userName: `用户${userId}`,
                    phone: '',
                    avatar: '',
                    userType: '',
                    canWithdraw: false,
                    staffRatingName: '',
                    ownerRoleType: '',
                    completedOrderSet: new Set<number>(),
                    dispatchSet: new Set<number>(),
                    grossPerformanceAmount: 0,
                    netIncomeAmount: 0,
                    totalContributionAmount: 0,
                    negativeIncomeAmount: 0,
                    hourlyIncome: 0,
                    guaranteedIncome: 0,
                    modePlayIncome: 0,
                    otherIncome: 0,
                    csIncome: 0,
                    withdrawSuccessAmount: 0,
                    walletAvailable: 0,
                    walletFrozen: 0,
                    walletTotal: 0,
                    lastStatsDate: null,
                });
            }

            const row = userMap.get(userId)!;
            const gross = Number(item.grossPerformanceAmount || 0);
            const net = Number(item.netIncomeAmount || 0);
            const negative = Number(item.negativeIncomeAmount || 0);
            const role = String(item.ownerRoleType || '');

            row.ownerRoleType = row.ownerRoleType || role;
            row.grossPerformanceAmount += gross;
            row.netIncomeAmount += net;
            row.negativeIncomeAmount += negative;

            if (role === 'PLAYER') {
                row.totalContributionAmount += gross - net;

                if (item.billingMode === 'HOURLY') {
                    row.hourlyIncome += net;
                } else if (item.billingMode === 'GUARANTEED') {
                    row.guaranteedIncome += net;
                } else if (item.billingMode === 'MODE_PLAY') {
                    row.modePlayIncome += net;
                } else {
                    row.otherIncome += net;
                }
            } else if (role === 'CS') {
                row.csIncome += net;
                // 客服不参与贡献统计
            } else {
                if (item.billingMode === 'HOURLY') {
                    row.hourlyIncome += net;
                } else if (item.billingMode === 'GUARANTEED') {
                    row.guaranteedIncome += net;
                } else if (item.billingMode === 'MODE_PLAY') {
                    row.modePlayIncome += net;
                } else {
                    row.otherIncome += net;
                }
            }

            if (item.orderId) row.completedOrderSet.add(Number(item.orderId));
            if (item.dispatchId) row.dispatchSet.add(Number(item.dispatchId));

            if (!row.lastStatsDate || new Date(item.statsDate) > row.lastStatsDate) {
                row.lastStatsDate = new Date(item.statsDate);
            }
        });

        walletAccounts.forEach((item) => {
            const userId = Number(item.userId || 0);
            if (!userId || !userMap.has(userId)) return;

            const row = userMap.get(userId)!;
            row.walletAvailable = Number(item.availableBalance || 0);
            row.walletFrozen = Number(item.frozenBalance || 0);
            row.walletTotal = row.walletAvailable + row.walletFrozen;
        });

        withdrawals.forEach((item) => {
            const userId = Number(item.userId || 0);
            if (!userId || !userMap.has(userId)) return;

            userMap.get(userId)!.withdrawSuccessAmount += Number(item.amount || 0);
        });

        return Array.from(userMap.values()).map((row) => ({
            userId: row.userId,
            userName: row.userName,
            phone: row.phone,
            avatar: row.avatar,
            userType: row.userType,
            ownerRoleType: row.ownerRoleType,
            canWithdraw: row.canWithdraw,
            staffRatingName: row.staffRatingName,

            completedOrders: row.completedOrderSet.size,
            totalDispatchRounds: row.dispatchSet.size,

            grossPerformanceAmount: this.round2(row.grossPerformanceAmount),
            netIncomeAmount: this.round2(row.netIncomeAmount),
            totalContributionAmount: this.round2(row.totalContributionAmount),
            negativeIncomeAmount: this.round2(row.negativeIncomeAmount),

            hourlyIncome: this.round2(row.hourlyIncome),
            guaranteedIncome: this.round2(row.guaranteedIncome),
            modePlayIncome: this.round2(row.modePlayIncome),
            otherIncome: this.round2(row.otherIncome),
            csIncome: this.round2(row.csIncome),

            withdrawSuccessAmount: this.round2(row.withdrawSuccessAmount),

            walletAvailable: this.round2(row.walletAvailable),
            walletFrozen: this.round2(row.walletFrozen),
            walletTotal: this.round2(row.walletTotal),

            lastStatsDate: row.lastStatsDate ? row.lastStatsDate.toISOString() : undefined,
        }));
    }

    private sortDashboardRows(
        rows: any[],
        sortField?: string,
        sortOrder?: 'ascend' | 'descend',
    ) {
        if (!sortField || !sortOrder) {
            return [...rows].sort(
                (a, b) => Number(b.netIncomeAmount || 0) - Number(a.netIncomeAmount || 0),
            );
        }

        return [...rows].sort((a, b) => {
            const av = Number(a?.[sortField] ?? 0);
            const bv = Number(b?.[sortField] ?? 0);
            return sortOrder === 'ascend' ? av - bv : bv - av;
        });
    }

    private round2(n: any) {
        const num = Number(n ?? 0);
        if (!Number.isFinite(num)) return 0;
        return Math.round(num * 100) / 100;
    }

    private formatDate(date: Date | string) {
        const d = new Date(date);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }

    private getTodayRange() {
        const now = new Date();
        const start = new Date(
            `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
                now.getDate(),
            ).padStart(2, '0')} 00:00:00`,
        );
        const end = new Date(
            `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
                now.getDate(),
            ).padStart(2, '0')} 23:59:59`,
        );
        return { start, end };
    }

    private buildDateSeriesFromPerfWhere(wherePack: any) {
        const gte = wherePack?.perfWhere?.statsDate?.gte;
        const lte = wherePack?.perfWhere?.statsDate?.lte;

        const end = lte ? new Date(lte) : new Date();
        const start = gte ? new Date(gte) : new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);

        const result: string[] = [];
        const cursor = new Date(start);

        while (cursor.getTime() <= end.getTime()) {
            result.push(this.formatDate(cursor));
            cursor.setDate(cursor.getDate() + 1);
        }

        return result;
    }
}