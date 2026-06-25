import {BadRequestException, Injectable} from '@nestjs/common';
import {PrismaService} from '../prisma.service';

@Injectable()
export class WalletDepositService {
    constructor(private readonly prisma: PrismaService) {}

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
                data: Array.isArray(data) ? data : [],
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
            data,
            total,
        };
    }
}
