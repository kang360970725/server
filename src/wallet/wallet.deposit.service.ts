import {BadRequestException, Injectable} from '@nestjs/common';
import {PrismaService} from '../prisma.service';

@Injectable()
export class WalletDepositService {
    constructor(
        private readonly prisma: PrismaService,
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
        operatorKey?: string;
        employmentStatus?: string;
        depositState?: string;
        manualOnly?: boolean;
    }) {
        const page = Math.max(1, Number(params.page || 1));
        const limit = Math.min(100, Math.max(1, Number(params.limit || 20)));
        const search = String(params.search || '').trim();
        const operatorKey = String(params.operatorKey || '').trim();

        const legacyTableExists = await this.tableExists('WalletDepositTransaction');
        const transactionRows = legacyTableExists
            ? await this.prisma.$queryRawUnsafe<any[]>(
                `
                    SELECT userId, amount, bizType, operatorId, createdAt
                    FROM wallet_deposit_transactions
                    UNION ALL
                    SELECT userId, amount, bizType, operatorId, createdAt
                    FROM WalletDepositTransaction
                `,
            )
            : await this.prisma.walletDepositTransaction.findMany({
                select: {
                    userId: true,
                    amount: true,
                    bizType: true,
                    operatorId: true,
                    createdAt: true,
                },
            });

        const allRows = (transactionRows || []).map((row) => ({
            userId: Number(row.userId),
            amount: this.round2(row.amount),
            bizType: String(row.bizType || ''),
            operatorId: row.operatorId === null || row.operatorId === undefined ? null : Number(row.operatorId),
            createdAt: row.createdAt,
        }));

        const userIds = Array.from(new Set(allRows.map((row) => row.userId).filter((id) => id > 0)));
        const operatorIds = Array.from(new Set(allRows.map((row) => row.operatorId || 0).filter((id) => id > 0)));

        const [users, operators] = await Promise.all([
            userIds.length
                ? this.prisma.user.findMany({
                    where: { id: { in: userIds } },
                    select: {
                        id: true,
                        phone: true,
                        name: true,
                        realName: true,
                        staffEmploymentStatus: true,
                    },
                })
                : [],
            operatorIds.length
                ? this.prisma.user.findMany({
                    where: { id: { in: operatorIds } },
                    select: { id: true, name: true, realName: true, phone: true },
                })
                : [],
        ]);

        const activeUsers = users.filter(
            (user) => !['EXITED', 'BLACKLISTED'].includes(String(user.staffEmploymentStatus || '').toUpperCase()),
        );
        const userMap = new Map<number, any>(activeUsers.map((user) => [user.id, user] as [number, any]));
        const activeUserIdSet = new Set(activeUsers.map((user) => user.id));
        const activeRows = allRows.filter((row) => activeUserIdSet.has(row.userId));
        const operatorMap = new Map<number, any>(operators.map((operator) => [operator.id, operator] as [number, any]));

        const matchesSearch = (...values: any[]) => {
            if (!search) return true;
            const lowerSearch = search.toLowerCase();
            return values.some((value) => String(value || '').toLowerCase().includes(lowerSearch));
        };
        const formatName = (user?: { name?: string | null; realName?: string | null; phone?: string | null }) =>
            user?.realName || user?.name || user?.phone || '';

        if (operatorKey) {
            const detailRows = activeRows.filter((row) => {
                if (operatorKey === 'SYSTEM') return !row.operatorId;
                const operatorId = Number(operatorKey.replace(/^OPERATOR_/, ''));
                return operatorId > 0 && row.operatorId === operatorId;
            });
            const staffMap = new Map<number, any>();
            for (const row of detailRows) {
                const user = userMap.get(row.userId);
                if (!user) continue;
                const current = staffMap.get(row.userId) || {
                    userId: row.userId,
                    name: user.name,
                    realName: user.realName,
                    phone: user.phone,
                    staffEmploymentStatus: user.staffEmploymentStatus,
                    depositAmount: 0,
                    transactionCount: 0,
                    latestAt: null,
                };
                current.depositAmount = this.round2(current.depositAmount + row.amount);
                current.transactionCount += 1;
                if (!current.latestAt || new Date(row.createdAt).getTime() > new Date(current.latestAt).getTime()) {
                    current.latestAt = row.createdAt;
                }
                staffMap.set(row.userId, current);
            }
            const rows = Array.from(staffMap.values())
                .filter((row) => matchesSearch(row.userId, row.phone, row.name, row.realName))
                .sort((a, b) => Math.abs(Number(b.depositAmount || 0)) - Math.abs(Number(a.depositAmount || 0)));
            const start = (page - 1) * limit;

            return {
                mode: 'DETAIL',
                data: rows.slice(start, start + limit),
                total: rows.length,
                summary: {
                    staffCount: rows.length,
                    totalAmount: this.round2(rows.reduce((sum, row) => sum + Number(row.depositAmount || 0), 0)),
                    transactionCount: rows.reduce((sum, row) => sum + Number(row.transactionCount || 0), 0),
                },
            };
        }

        const groupMap = new Map<string, any>();
        for (const row of activeRows) {
            const key = row.operatorId ? `OPERATOR_${row.operatorId}` : 'SYSTEM';
            const operator = row.operatorId ? operatorMap.get(row.operatorId) : null;
            const current = groupMap.get(key) || {
                groupKey: key,
                operatorId: row.operatorId,
                operatorName: operator ? formatName(operator) : '系统扣费/系统处理',
                operatorPhone: operator?.phone || '',
                sourceType: row.operatorId ? 'MANUAL_OPERATOR' : 'SYSTEM',
                totalAmount: 0,
                transactionCount: 0,
                staffIds: new Set<number>(),
                latestAt: null,
            };
            current.totalAmount = this.round2(current.totalAmount + row.amount);
            current.transactionCount += 1;
            current.staffIds.add(row.userId);
            if (!current.latestAt || new Date(row.createdAt).getTime() > new Date(current.latestAt).getTime()) {
                current.latestAt = row.createdAt;
            }
            groupMap.set(key, current);
        }

        const rows = Array.from(groupMap.values())
            .map((row) => ({
                ...row,
                staffCount: row.staffIds.size,
                staffIds: undefined,
            }))
            .filter((row) => matchesSearch(row.operatorId, row.operatorName, row.operatorPhone, row.sourceType === 'SYSTEM' ? '系统' : '录入人'))
            .sort((a, b) => Math.abs(Number(b.totalAmount || 0)) - Math.abs(Number(a.totalAmount || 0)));

        const start = (page - 1) * limit;

        return {
            mode: 'GROUP',
            data: rows.slice(start, start + limit),
            total: rows.length,
            summary: {
                groupCount: rows.length,
                staffCount: new Set(activeRows.map((row) => row.userId)).size,
                transactionCount: rows.reduce((sum, row) => sum + Number(row.transactionCount || 0), 0),
                totalAmount: this.round2(rows.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0)),
                manualOperatorAmount: this.round2(rows
                    .filter((row) => row.sourceType === 'MANUAL_OPERATOR')
                    .reduce((sum, row) => sum + Number(row.totalAmount || 0), 0)),
                systemAmount: this.round2(rows
                    .filter((row) => row.sourceType === 'SYSTEM')
                    .reduce((sum, row) => sum + Number(row.totalAmount || 0), 0)),
            },
        };
    }

}
