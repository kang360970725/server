import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * WalletService（V0.1）
 *
 * 设计目标：
 * - 所有“钱包账户创建/钱包流水/冻结解冻”都应从这里集中处理，避免散落在 Orders/Users 中
 * - Step 2：先只做 “确保钱包账户存在”，为后续结算入账做准备
 *
 * 注意事项：
 * - 未来我们在 completeDispatch 结算入账时，会在事务中调用这里的方法；
 *   所以这里支持传入 tx（Prisma Transaction Client）以保持原子性。
 */

// type PrismaTx = | import('@prisma/client').PrismaClient | Prisma.TransactionClient;
type PrismaTx = PrismaClient | Prisma.TransactionClient;

/** 金额统一保留 2 位（避免浮点尾差扩散） */
function round2(n: number) {
    return Math.round(n * 100) / 100;
}


@Injectable()
export class WalletService {
    constructor(private prisma: PrismaService) {}

    /**
     * 确保指定用户存在 WalletAccount（一人一账）
     *
     * 适用场景：
     * - 老用户回填（批处理或启动时）
     * - 新用户注册/创建后立即绑定
     * - 后续结算入账前兜底（即便漏建也能自动补齐）
     *
     * 幂等：
     * - 若已存在则直接返回
     */
    async ensureWalletAccount(userId: number, tx?: PrismaTx) {
        const db = (tx as any) ?? this.prisma;

        // 先查再建（避免 unique 冲突）
        const existing = await db.walletAccount.findUnique({
            where: { userId },
        });

        if (existing) return existing;

        // 创建钱包账户（available/frozen 默认 0）
        return db.walletAccount.create({
            data: { userId },
        });
    }

    /**
     * 创建“结算收益入账（冻结）”
     *
     * ✅ 幂等策略（非常重要）：
     * - 以 (sourceType, sourceId) 作为唯一幂等键（你 schema 已有 unique）
     * - 如果该收益流水已存在，则直接返回，不重复加钱
     * - 如果收益流水存在但冻结单不存在，则补建冻结单（兼容中断/半成功）
     *
     * 约定：
     * - sourceType: V0.1 固定使用 'ORDER_SETTLEMENT'
     * - sourceId: 结算明细 OrderSettlement.id
     *
     * 不在这里判断“体验单/非体验单”，unlockAt 由调用方计算传入
     */
    async createFrozenSettlementEarning(params: {
        userId: number;
        amount: number;
        unlockAt: Date;

        // 幂等来源
        sourceType?: string; // default 'ORDER_SETTLEMENT'
        sourceId: number;

        // 可选冗余关联，方便对账
        orderId?: number | null;
        dispatchId?: number | null;
        settlementId?: number | null;
    }, tx?: PrismaTx) {
        const db = (tx as any) ?? this.prisma;

        const sourceType = params.sourceType ?? 'ORDER_SETTLEMENT';
        const amount = round2(params.amount);

        if (amount <= 0) {
            // 结算收益为 0 的情况：不入账、不建冻结单（避免产生无意义流水）
            return { created: false, tx: null as any, hold: null as any };
        }

        // 1) 查是否已存在该来源的收益流水（幂等）
        const existingTx = await db.walletTransaction.findFirst({
            where: {
                sourceType,
                sourceId: params.sourceId,
            },
            select: { id: true, userId: true, amount: true, status: true },
        });

        // 2) 如果已存在：确保冻结单存在（补偿），然后返回
        if (existingTx) {
            const existingHold = await db.walletHold.findFirst({
                where: { earningTxId: existingTx.id },
                select: { id: true, status: true },
            });

            if (!existingHold) {
                await db.walletHold.create({
                    data: {
                        userId: params.userId,
                        earningTxId: existingTx.id,
                        amount,
                        status: 'FROZEN',
                        unlockAt: params.unlockAt,
                    },
                });

                // 冻结单补建时，账户 frozenBalance 可能没加过，这里做一次兜底修正：
                // - 只有当收益流水还是 FROZEN 时才补增 frozenBalance
                if (existingTx.status === 'FROZEN') {
                    await this.ensureWalletAccount(params.userId, db as any);
                    await db.walletAccount.update({
                        where: { userId: params.userId },
                        data: { frozenBalance: { increment: amount } },
                    });
                }
            }

            return { created: false, tx: existingTx, hold: existingHold };
        }

        // 3) 不存在则创建：建议在事务里执行，确保“流水 + 冻结单 + 账户汇总”原子一致
        //    如果外部没传 tx，这里自己包一层 transaction
        const runner = async (t: PrismaTx) => {
            // 3.1 兜底确保账户存在
            await this.ensureWalletAccount(params.userId, t as any);

            // 3.2 创建收益流水（冻结）
            const earningTx = await (t as any).walletTransaction.create({
                data: {
                    userId: params.userId,
                    direction: 'IN',
                    bizType: 'SETTLEMENT_EARNING',
                    amount,
                    status: 'FROZEN',
                    sourceType,
                    sourceId: params.sourceId,
                    orderId: params.orderId ?? null,
                    dispatchId: params.dispatchId ?? null,
                    settlementId: params.settlementId ?? null,
                },
            });

            // 3.3 创建冻结单
            const hold = await (t as any).walletHold.create({
                data: {
                    userId: params.userId,
                    earningTxId: earningTx.id,
                    amount,
                    status: 'FROZEN',
                    unlockAt: params.unlockAt,
                },
            });

            // 3.4 汇总账户：冻结余额 +amount
            await (t as any).walletAccount.update({
                where: { userId: params.userId },
                data: { frozenBalance: { increment: amount } },
            });

            return { created: true, tx: earningTx, hold };
        };

        // 外部传了 tx 就用外部 tx（让 OrdersService 将来能把“结算+钱包入账”做成一个大事务）
        if (tx) {
            return runner(tx);
        }

        // 否则内部开启事务
        return this.prisma.$transaction(async (t) => runner(t as any));
    }


    /**
     * 单次批处理：释放一批到期冻结单
     * - 使用 UTC_TIMESTAMP() 比较，避免 DATETIME 时区混乱
     */
    async releaseDueHoldsOnce(options?: { batchSize?: number }) {
        const batchSize = options?.batchSize ?? 200;

        // 用 DB 的 UTC 时间进行比较，彻底规避“应用 UTC vs DB 本地 NOW()”的问题
        const dueHolds = await this.prisma.$queryRaw<
            { id: number; userId: number; amount: number; earningTxId: number }[]
            >`
      SELECT id, userId, amount, earningTxId
      FROM wallet_holds
      WHERE status = 'FROZEN'
        AND unlockAt <= UTC_TIMESTAMP()
      ORDER BY unlockAt ASC
      LIMIT ${batchSize}
    `;

        let releasedCount = 0;

        for (const hold of dueHolds) {
            try {
                await this.prisma.$transaction(async (tx) => {
                    // 并发保护：二次确认
                    const fresh = await tx.walletHold.findUnique({
                        where: { id: hold.id },
                        select: { status: true },
                    });
                    if (!fresh || fresh.status !== 'FROZEN') return;

                    await this.ensureWalletAccount(hold.userId, tx as any);

                    const releaseSourceType = 'WALLET_HOLD_RELEASE';

                    // 不依赖复合 unique where 名称，避免类型/命名差异
                    const existingRelease = await tx.walletTransaction.findFirst({
                        where: {
                            sourceType: releaseSourceType,
                            sourceId: hold.earningTxId,
                        },
                        select: { id: true },
                    });

                    if (!existingRelease) {
                        const amount = round2(hold.amount);

                        await tx.walletTransaction.create({
                            data: {
                                userId: hold.userId,
                                direction: 'IN',
                                bizType: 'RELEASE_FROZEN',
                                amount,
                                status: 'AVAILABLE',
                                sourceType: releaseSourceType,
                                sourceId: hold.earningTxId,
                            },
                        });

                        await tx.walletAccount.update({
                            where: { userId: hold.userId },
                            data: {
                                frozenBalance: { decrement: amount },
                                availableBalance: { increment: amount },
                            },
                        });

                        // 同步把原收益流水标记为 AVAILABLE（可选但建议）
                        await tx.walletTransaction.update({
                            where: { id: hold.earningTxId },
                            data: { status: 'AVAILABLE' },
                        });
                    }

                    await tx.walletHold.update({
                        where: { id: hold.id },
                        data: { status: 'RELEASED', releasedAt: new Date() },
                    });
                });

                releasedCount++;
            } catch (e: any) {
                // 单条失败不影响整批，但要留日志，避免你之前“无感失败”
                console.error('[releaseDueHoldsOnce] failed holdId=', hold.id, e?.message || e);
            }
        }

        return { releasedCount };
    }

    /**
     * 多批处理：while 循环调用单批处理直到跑空
     * - 用于“每天 08:00 跑一次，但不怕数据量超 200”
     */
    async releaseDueHoldsInBatches(options?: { batchSize?: number; maxBatches?: number }) {
        const batchSize = options?.batchSize ?? 200;
        const maxBatches = options?.maxBatches ?? 500; // 防止极端情况下死循环（基本不会触发）

        let totalReleased = 0;
        for (let i = 0; i < maxBatches; i++) {
            const { releasedCount } = await this.releaseDueHoldsOnce({ batchSize });
            totalReleased += releasedCount;

            // 如果本批不足 batchSize，说明已经跑空
            if (releasedCount < batchSize) break;
        }

        return { totalReleased };
    }

}
