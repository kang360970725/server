import {BadRequestException, Injectable} from '@nestjs/common';
import {PrismaService} from '../prisma.service';
import { StaffEmploymentStatus, UserType } from '@prisma/client';
import { StaffRuleEngineService } from '../system-config/staff-rule-engine.service';

@Injectable()
export class WalletDepositService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly staffRuleEngineService: StaffRuleEngineService,
    ) {}

    private async tableExists(tableName: string) {
        const rows = await this.prisma.$queryRawUnsafe<Array<{ table_name?: string }>>(
            `
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = DATABASE()
                  AND table_name = ?
                LIMIT 1
            `,
            tableName,
        );
        return Array.isArray(rows) && rows.length > 0;
    }

    private round2(v: any) {
        return Math.round((Number(v) || 0) * 100) / 100;
    }

    private normalizeDepositState(value?: string) {
        const v = String(value || 'ALL').trim().toUpperCase();
        return ['ALL', 'EFFECTIVE', 'INVALID', 'EXITED_OR_BLACKLISTED', 'ZERO'].includes(v) ? v : 'ALL';
    }

    private normalizeEmploymentStatus(value?: string) {
        const v = String(value || '').trim().toUpperCase();
        return Object.values(StaffEmploymentStatus).includes(v as StaffEmploymentStatus)
            ? (v as StaffEmploymentStatus)
            : undefined;
    }

    private async attachOperators<T extends { operatorId?: number | null }>(rows: T[]) {
        const operatorIds = Array.from(
            new Set(rows.map((row) => Number(row.operatorId || 0)).filter((id) => id > 0)),
        );
        if (!operatorIds.length) {
            return rows.map((row) => ({ ...row, operatorName: '', operatorPhone: '' }));
        }

        const operators = await this.prisma.user.findMany({
            where: { id: { in: operatorIds } },
            select: { id: true, name: true, realName: true, phone: true },
        });
        const operatorMap = new Map(operators.map((operator) => [operator.id, operator]));

        return rows.map((row) => {
            const operator = operatorMap.get(Number(row.operatorId || 0));
            return {
                ...row,
                operatorName: operator?.realName || operator?.name || '',
                operatorPhone: operator?.phone || '',
            };
        });
    }

    /**
     * 获取押金余额
     */
    async getDepositBalance(userId: number) {
        const account = await this.prisma.walletAccount.findUnique({
            where: { userId },
            select: { depositBalance: true },
        });

        if (!account) {
            throw new BadRequestException('钱包账户不存在');
        }

        return Number(account.depositBalance || 0);
    }

    /**
     * 增加押金
     */
    async addDeposit(params: {
        userId: number;
        amount: number;
        bizType: any;
        remark?: string;
        operatorId?: number;
    }) {
        const { userId, amount, bizType, remark, operatorId } = params;

        if (!amount || amount <= 0) {
            throw new BadRequestException('押金金额必须大于0');
        }

        return this.prisma.$transaction(async (tx) => {
            const account = await tx.walletAccount.findUnique({
                where: { userId },
                select: { depositBalance: true, availableBalance: true, frozenBalance: true },
            });

            if (!account) {
                throw new BadRequestException('钱包账户不存在');
            }

            const newBalance =
                Number(account.depositBalance || 0) + Number(amount);

            // 更新押金余额
            await tx.walletAccount.update({
                where: { userId },
                data: {
                    depositBalance: newBalance,
                },
            });

            // 写押金流水
            const record = await tx.walletDepositTransaction.create({
                data: {
                    userId,
                    amount,
                    bizType,
                    remark,
                    operatorId,
                },
            });

            await tx.walletTransaction.create({
                data: {
                    userId,
                    direction: 'IN',
                    bizType: 'DEPOSIT_ADD',
                    amount: this.round2(amount),
                    status: 'AVAILABLE',
                    sourceType: 'WALLET_DEPOSIT',
                    sourceId: record.id,
                    availableAfter: this.round2(Number(account.availableBalance || 0)),
                    frozenAfter: this.round2(Number(account.frozenBalance || 0)),
                },
            });

            return {
                depositBalance: newBalance,
                record,
            };
        });
    }

    /**
     * 扣除押金
     */
    async deductDeposit(params: {
        userId: number;
        amount: number;
        bizType: any;
        remark?: string;
        operatorId?: number;
    }) {
        const { userId, amount, bizType, remark, operatorId } = params;

        if (!amount || amount <= 0) {
            throw new BadRequestException('扣除金额必须大于0');
        }

        return this.prisma.$transaction(async (tx) => {
            const account = await tx.walletAccount.findUnique({
                where: { userId },
                select: { depositBalance: true, availableBalance: true, frozenBalance: true },
            });

            if (!account) {
                throw new BadRequestException('钱包账户不存在');
            }

            const balance = Number(account.depositBalance || 0);

            if (balance < amount) {
                throw new BadRequestException('押金余额不足');
            }

            const newBalance = balance - amount;

            // 更新押金余额
            await tx.walletAccount.update({
                where: { userId },
                data: {
                    depositBalance: newBalance,
                },
            });

            // 写押金流水
            const record = await tx.walletDepositTransaction.create({
                data: {
                    userId,
                    amount: -amount,
                    bizType,
                    remark,
                    operatorId,
                },
            });

            await tx.walletTransaction.create({
                data: {
                    userId,
                    direction: 'OUT',
                    bizType: 'DEPOSIT_DEDUCT',
                    amount: this.round2(amount),
                    status: 'AVAILABLE',
                    sourceType: 'WALLET_DEPOSIT',
                    sourceId: record.id,
                    availableAfter: this.round2(Number(account.availableBalance || 0)),
                    frozenAfter: this.round2(Number(account.frozenBalance || 0)),
                },
            });

            return {
                depositBalance: newBalance,
                record,
            };
        });
    }

    async manualDeposit(params: {
        userId: number;
        amount: number;
        remark?: string;
        operatorId?: number;
    }) {

        const { userId, amount, remark, operatorId } = params;

        if (!amount || amount <= 0) {
            throw new BadRequestException('金额非法');
        }

        return this.prisma.$transaction(async (tx) => {

            const accountAfter = await tx.walletAccount.update({
                where: { userId },
                data: {
                    depositBalance: {
                        increment: amount,
                    },
                },
                select: {
                    availableBalance: true,
                    frozenBalance: true,
                },
            });

            const depositTx = await tx.walletDepositTransaction.create({
                data: {
                    userId,
                    amount,
                    bizType: 'MANUAL_DEPOSIT',
                    remark: remark || '',
                    operatorId: operatorId ?? null,
                },
            });

            await tx.walletTransaction.create({
                data: {
                    userId,
                    direction: 'IN',
                    bizType: 'DEPOSIT_ADD',
                    amount: this.round2(amount),
                    status: 'AVAILABLE',
                    sourceType: 'WALLET_DEPOSIT',
                    sourceId: depositTx.id,
                    availableAfter: this.round2(Number(accountAfter.availableBalance || 0)),
                    frozenAfter: this.round2(Number(accountAfter.frozenBalance || 0)),
                },
            });

            return depositTx;
        });
    }

    async listDepositTransactions(params: {
        userId: number;
        page: number;
        limit: number;
    }) {

        const { userId, page, limit } = params;
        const offset = (page - 1) * limit;

        const where: any = {};

        if (userId) {
            where.userId = userId;
        }

        const legacyTableExists = await this.tableExists('WalletDepositTransaction');

        if (legacyTableExists) {
            const whereSql = userId ? 'WHERE userId = ?' : '';
            const whereArgs = userId ? [userId] : [];

            const data = await this.prisma.$queryRawUnsafe<any[]>(
                `
                    SELECT id, userId, amount, bizType, remark, operatorId, createdAt
                    FROM (
                        SELECT id, userId, amount, bizType, remark, operatorId, createdAt
                        FROM wallet_deposit_transactions
                        ${whereSql}
                        UNION ALL
                        SELECT id, userId, amount, bizType, remark, operatorId, createdAt
                        FROM WalletDepositTransaction
                        ${whereSql}
                    ) t
                    ORDER BY createdAt DESC, id DESC
                    LIMIT ? OFFSET ?
                `,
                ...whereArgs,
                ...whereArgs,
                limit,
                offset,
            );

            const totalRows = await this.prisma.$queryRawUnsafe<Array<{ total?: bigint | number }>>(
                `
                    SELECT SUM(cnt) AS total
                    FROM (
                        SELECT COUNT(*) AS cnt
                        FROM wallet_deposit_transactions
                        ${whereSql}
                        UNION ALL
                        SELECT COUNT(*) AS cnt
                        FROM WalletDepositTransaction
                        ${whereSql}
                    ) c
                `,
                ...whereArgs,
                ...whereArgs,
            );

            return {
                data: await this.attachOperators(Array.isArray(data) ? data : []),
                total: Number(totalRows?.[0]?.total || 0),
            };
        }

        const [data, total] = await this.prisma.$transaction([
            this.prisma.walletDepositTransaction.findMany({
                where,
                orderBy: {
                    createdAt: 'desc',
                },
                skip: (page - 1) * limit,
                take: limit,
            }),

            this.prisma.walletDepositTransaction.count({
                where,
            }),
        ]);

        return {
            data: await this.attachOperators(data as any[]),
            total,
        };
    }

    async listDepositReconciliation(params: {
        page: number;
        limit: number;
        search?: string;
        employmentStatus?: string;
        depositState?: string;
        manualOnly?: boolean;
    }) {
        const page = Math.max(1, Number(params.page || 1));
        const limit = Math.min(100, Math.max(1, Number(params.limit || 20)));
        const search = String(params.search || '').trim();
        const employmentStatus = this.normalizeEmploymentStatus(params.employmentStatus);
        const depositState = this.normalizeDepositState(params.depositState);

        const where: any = {
            OR: [
                { userType: UserType.STAFF },
                { walletAccount: { is: { depositBalance: { not: 0 } } } },
                { depositTransactions: { some: {} } },
            ],
        };
        if (employmentStatus) where.staffEmploymentStatus = employmentStatus;
        if (search) {
            const searchNumber = Number(search);
            const searchOr = [
                Number.isFinite(searchNumber) ? { id: searchNumber } : undefined,
                { phone: { contains: search } },
                { name: { contains: search } },
                { realName: { contains: search } },
                { idCard: { contains: search } },
            ].filter(Boolean);
            where.AND = [{ OR: searchOr }];
        }

        const users = await this.prisma.user.findMany({
            where,
            select: {
                id: true,
                phone: true,
                name: true,
                realName: true,
                userType: true,
                staffEmploymentStatus: true,
                staffTags: true,
                depositLimit: true,
                createdAt: true,
                staffExitedAt: true,
                walletAccount: {
                    select: {
                        depositBalance: true,
                        availableBalance: true,
                        frozenBalance: true,
                    },
                },
                staffRating: {
                    select: {
                        name: true,
                    },
                },
                Role: {
                    select: {
                        name: true,
                    },
                },
            },
            orderBy: { id: 'desc' },
        });

        const userIds = users.map((u) => u.id);
        const [manualGroups, totalGroups, latestRows, latestManualRows, config] = await Promise.all([
            userIds.length
                ? this.prisma.walletDepositTransaction.groupBy({
                    by: ['userId'],
                    where: { userId: { in: userIds }, bizType: 'MANUAL_DEPOSIT' as any },
                    _sum: { amount: true },
                    _count: { _all: true },
                })
                : [],
            userIds.length
                ? this.prisma.walletDepositTransaction.groupBy({
                    by: ['userId'],
                    where: { userId: { in: userIds } },
                    _sum: { amount: true },
                    _count: { _all: true },
                })
                : [],
            userIds.length
                ? this.prisma.walletDepositTransaction.findMany({
                    where: { userId: { in: userIds } },
                    select: { userId: true, createdAt: true },
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                })
                : [],
            userIds.length
                ? this.prisma.walletDepositTransaction.findMany({
                    where: { userId: { in: userIds }, bizType: 'MANUAL_DEPOSIT' as any },
                    select: { userId: true, operatorId: true, createdAt: true },
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                })
                : [],
            this.staffRuleEngineService.getConfig(),
        ]);

        const manualMap = new Map<number, any>((manualGroups as any[]).map((row: any) => [Number(row.userId), row] as [number, any]));
        const totalMap = new Map<number, any>((totalGroups as any[]).map((row: any) => [Number(row.userId), row] as [number, any]));
        const latestMap = new Map<number, Date>();
        for (const row of latestRows as any[]) {
            if (!latestMap.has(row.userId)) latestMap.set(row.userId, row.createdAt);
        }
        const latestManualMap = new Map<number, any>();
        for (const row of latestManualRows as any[]) {
            if (!latestManualMap.has(row.userId)) latestManualMap.set(row.userId, row);
        }
        const operatorIds = Array.from(
            new Set((latestManualRows as any[]).map((row) => Number(row.operatorId || 0)).filter((id) => id > 0)),
        );
        const operators = operatorIds.length
            ? await this.prisma.user.findMany({
                where: { id: { in: operatorIds } },
                select: { id: true, name: true, realName: true, phone: true },
            })
            : [];
        const operatorMap = new Map(operators.map((operator) => [operator.id, operator]));

        const rows = users.map((user: any) => {
            const depositBalance = this.round2(user.walletAccount?.depositBalance ?? 0);
            const manual = manualMap.get(user.id) as any;
            const total = totalMap.get(user.id) as any;
            const manualDepositAmount = this.round2(manual?._sum?.amount ?? 0);
            const latestManual = latestManualMap.get(user.id);
            const latestManualOperator = operatorMap.get(Number(latestManual?.operatorId || 0));
            const depositNetAmount = this.round2(total?._sum?.amount ?? 0);
            const deductionAmount = this.round2(Math.abs(Math.min(0, depositNetAmount - manualDepositAmount)));
            const matchedRule = user.userType === UserType.STAFF
                ? this.staffRuleEngineService.resolveMatchedRule(config, user.staffTags)
                : null;
            const requiredDeposit = user.userType === UserType.STAFF
                ? this.round2(matchedRule?.depositAmount ?? user.depositLimit ?? 500)
                : null;
            const activeLike = [StaffEmploymentStatus.ACTIVE, StaffEmploymentStatus.FROZEN].includes(user.staffEmploymentStatus);
            const exitedOrBlacklisted = [StaffEmploymentStatus.EXITED, StaffEmploymentStatus.BLACKLISTED].includes(user.staffEmploymentStatus);
            const state = activeLike && depositBalance > 0
                ? 'EFFECTIVE'
                : exitedOrBlacklisted
                    ? 'EXITED_OR_BLACKLISTED'
                    : 'ZERO';
            const statusLabel = state === 'EFFECTIVE'
                ? '有效'
                : state === 'EXITED_OR_BLACKLISTED'
                    ? '退店/黑名单'
                    : '无保证金';
            const gapToRule = activeLike && requiredDeposit !== null ? this.round2(depositBalance - requiredDeposit) : null;

            return {
                userId: user.id,
                phone: user.phone,
                name: user.name,
                realName: user.realName,
                userType: user.userType,
                roleName: user.Role?.name || '',
                ratingName: user.staffRating?.name || '',
                staffEmploymentStatus: user.staffEmploymentStatus,
                staffTags: Array.isArray(user.staffTags) ? user.staffTags : [],
                depositBalance,
                requiredDeposit,
                gapToRule,
                manualDepositAmount,
                latestManualDepositAt: latestManual?.createdAt || null,
                latestManualOperatorId: latestManual?.operatorId || null,
                latestManualOperatorName: latestManualOperator?.realName || latestManualOperator?.name || '',
                latestManualOperatorPhone: latestManualOperator?.phone || '',
                depositNetAmount,
                deductionAmount,
                transactionCount: Number(total?._count?._all || 0),
                manualTransactionCount: Number(manual?._count?._all || 0),
                latestDepositAt: latestMap.get(user.id) || null,
                staffExitedAt: user.staffExitedAt,
                createdAt: user.createdAt,
                depositState: state,
                depositStateLabel: statusLabel,
            };
        }).filter((row) => {
            if (params.manualOnly && row.manualTransactionCount <= 0) return false;
            if (depositState === 'ALL') return true;
            if (depositState === 'INVALID') return row.depositState !== 'EFFECTIVE';
            return row.depositState === depositState;
        });

        const totalDepositBalance = this.round2(rows.reduce((sum, row) => sum + row.depositBalance, 0));
        const totalManualDepositAmount = this.round2(rows.reduce((sum, row) => sum + row.manualDepositAmount, 0));
        const effectiveDepositBalance = this.round2(rows.filter((row) => row.depositState === 'EFFECTIVE').reduce((sum, row) => sum + row.depositBalance, 0));
        const invalidDepositBalance = this.round2(rows.filter((row) => row.depositState !== 'EFFECTIVE').reduce((sum, row) => sum + row.depositBalance, 0));
        const start = (page - 1) * limit;

        return {
            data: rows.slice(start, start + limit),
            total: rows.length,
            summary: {
                staffCount: rows.length,
                totalDepositBalance,
                totalManualDepositAmount,
                effectiveDepositBalance,
                invalidDepositBalance,
                effectiveCount: rows.filter((row) => row.depositState === 'EFFECTIVE').length,
                invalidCount: rows.filter((row) => row.depositState !== 'EFFECTIVE').length,
                exitedOrBlacklistedCount: rows.filter((row) => row.depositState === 'EXITED_OR_BLACKLISTED').length,
            },
        };
    }
}
