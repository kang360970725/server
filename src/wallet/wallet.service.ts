import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma, PrismaClient, WalletBizType, WalletDirection, WalletHoldStatus, WalletTxStatus } from '@prisma/client';
import {QueryWalletHoldsDto} from "./dto/query-wallet-holds.dto";
import {QueryWalletTransactionsDto} from "./dto/query-wallet-transactions.dto";

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
    // 生成 16 位 UID：A-Z0-9（全大写）
    private generateWalletUid(): string {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let s = '';
        for (let i = 0; i < 16; i++) {
            s += alphabet[Math.floor(Math.random() * alphabet.length)];
        }
        return s;
    }

    async ensureWalletAccount(userId: number, tx?: PrismaTx) {
        const db = (tx as any) ?? this.prisma;

        const existing = await db.walletAccount.findUnique({
            where: { userId },
        });

        // ✅ 已存在：若 walletUid 为空则补齐（兼容历史数据）
        if (existing) {
            if (!existing.walletUid) {
                for (let i = 0; i < 5; i++) {
                    try {
                        const uid = this.generateWalletUid();
                        return await db.walletAccount.update({
                            where: { userId },
                            data: { walletUid: uid },
                        });
                    } catch (e: any) {
                        // 唯一冲突就重试（极低概率）
                        if (e?.code === 'P2002') continue;
                        throw e;
                    }
                }
                // 5 次都冲突：极端情况
                throw new Error('Failed to generate unique walletUid');
            }
            return existing;
        }

        // ✅ 不存在：创建时写入 walletUid
        for (let i = 0; i < 5; i++) {
            try {
                const uid = this.generateWalletUid();
                return await db.walletAccount.create({
                    data: { userId, walletUid: uid },
                });
            } catch (e: any) {
                if (e?.code === 'P2002') continue;
                throw e;
            }
        }

        throw new Error('Failed to create wallet account with unique walletUid');
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
    },
                                        tx?: PrismaTx) {
        console.log('[createFrozenSettlementEarning] userId=', params.userId, 'amount=', params.amount, 'sourceType=', params.sourceType ?? 'ORDER_SETTLEMENT', 'sourceId=', params.sourceId);
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
     * 退款冲正：按订单维度冲正所有“结算收益入账”流水（含冻结/已解冻两种情况）
     *
     * 设计目标：
     * 1) 退款后，原收益不再参与统计（earningTx.status -> REVERSED）
     * 2) 如果收益还在冻结中：直接取消冻结，并回退 frozenBalance
     * 3) 如果收益已经可用：生成一笔 OUT 的冲正流水，并回退 availableBalance
     * 4) 幂等：同一 earningTx 只会被冲正一次（判断 earningTx.status===REVERSED 或已存在 reversal 流水）
     */
    async reverseOrderSettlementEarnings(params: {
        orderId: number;
        reason?: string; // 预留：后续可写到 remark / metadata
    }, tx?: Prisma.TransactionClient) {
        const db = (tx as any) ?? this.prisma;

        // 找到该订单下所有“结算收益流水”
        const earningTxs = await db.walletTransaction.findMany({
            where: {
                orderId: params.orderId,
                sourceType: 'ORDER_SETTLEMENT',
                bizType: WalletBizType.SETTLEMENT_EARNING,
            },
            select: {
                id: true,
                userId: true,
                amount: true,
                status: true,
            },
        });

        if (earningTxs.length === 0) {
            // 没有钱包收益流水：直接返回（不抛错，避免退款流程被钱包阻断）
            return { reversedCount: 0 };
        }

        const runner = async (t: Prisma.TransactionClient) => {
            let reversedCount = 0;

            for (const earningTx of earningTxs) {
                // 幂等：已经冲正过的不再处理
                if (earningTx.status === WalletTxStatus.REVERSED) continue;

                // 再做一次幂等：是否已存在冲正流水（以 reversalOfTxId=earningTx.id 判断）
                const existingReversal = await t.walletTransaction.findFirst({
                    where: {
                        reversalOfTxId: earningTx.id,
                        bizType: WalletBizType.REFUND_REVERSAL,
                    },
                    select: { id: true },
                });
                if (existingReversal) {
                    // 再保险：把 earningTx 标记为 REVERSED（可能曾中断导致没标记）
                    await t.walletTransaction.update({
                        where: { id: earningTx.id },
                        data: { status: WalletTxStatus.REVERSED },
                    });
                    reversedCount++;
                    continue;
                }

                // 确保账户存在
                await this.ensureWalletAccount(earningTx.userId, t as any);

                // 是否有冻结单
                const hold = await t.walletHold.findUnique({
                    where: { earningTxId: earningTx.id },
                    select: { id: true, status: true, amount: true },
                });

                const amount = Math.round(Number(earningTx.amount) * 100) / 100;

                // 情况 1：收益还在冻结中（典型：未到 unlockAt 就退款）
                if (earningTx.status === WalletTxStatus.FROZEN) {
                    // 1.1 回退 frozenBalance
                    await t.walletAccount.update({
                        where: { userId: earningTx.userId },
                        data: { frozenBalance: { decrement: amount } },
                    });

                    // 1.2 取消冻结单（若存在且仍 FROZEN）
                    if (hold && hold.status === WalletHoldStatus.FROZEN) {
                        await t.walletHold.update({
                            where: { id: hold.id },
                            data: {
                                status: WalletHoldStatus.CANCELLED,
                                // releasedAt 不写也行；这里写入表示“结束”
                                releasedAt: new Date(),
                            },
                        });
                    }

                    // 1.3 标记原收益流水为已冲正（不参与统计）
                    await t.walletTransaction.update({
                        where: { id: earningTx.id },
                        data: { status: WalletTxStatus.REVERSED },
                    });

                    reversedCount++;
                    continue;
                }

                // 情况 2：收益已可用（已经解冻到 availableBalance）
                if (earningTx.status === WalletTxStatus.AVAILABLE) {
                    // 2.1 生成冲正流水（OUT）
                    await t.walletTransaction.create({
                        data: {
                            userId: earningTx.userId,
                            direction: WalletDirection.OUT,
                            bizType: WalletBizType.REFUND_REVERSAL,
                            amount,
                            status: WalletTxStatus.AVAILABLE, // 冲正立即生效
                            sourceType: 'REFUND_REVERSAL',
                            sourceId: earningTx.id,
                            reversalOfTxId: earningTx.id,
                            orderId: params.orderId,
                        },
                    });

                    // 2.2 回退 availableBalance
                    await t.walletAccount.update({
                        where: { userId: earningTx.userId },
                        data: { availableBalance: { decrement: amount } },
                    });

                    // 2.3 标记原收益流水为已冲正
                    await t.walletTransaction.update({
                        where: { id: earningTx.id },
                        data: { status: WalletTxStatus.REVERSED },
                    });

                    // 2.4 如果存在“解冻流水”，也标记为 REVERSED（不参与统计）
                    // 解冻流水的幂等口径：sourceType='WALLET_HOLD_RELEASE', sourceId=earningTx.id
                    const releaseTx = await t.walletTransaction.findFirst({
                        where: {
                            sourceType: 'WALLET_HOLD_RELEASE',
                            sourceId: earningTx.id,
                            bizType: WalletBizType.RELEASE_FROZEN,
                        },
                        select: { id: true, status: true },
                    });
                    if (releaseTx && releaseTx.status !== WalletTxStatus.REVERSED) {
                        await t.walletTransaction.update({
                            where: { id: releaseTx.id },
                            data: { status: WalletTxStatus.REVERSED },
                        });
                    }

                    reversedCount++;
                    continue;
                }

                // 兜底：未知状态（理论上不会发生）
                throw new BadRequestException(`Unsupported WalletTxStatus for earningTx=${earningTx.id}`);
            }

            return { reversedCount };
        };

        // 如果外部传 tx，就复用外部事务；否则内部开事务
        if (tx) return runner(tx);
        return this.prisma.$transaction((t) => runner(t));
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

    /**
     * 获取/创建当前用户钱包账户
     * - 给前端 Overview 用
     */
    async getOrCreateMyAccount(userId: number) {
        if (!userId) throw new BadRequestException('无效的 userId');

        await this.ensureWalletAccount(userId, this.prisma as any);

        return this.prisma.walletAccount.findUnique({
            where: { userId },
            select: {
                id: true,
                userId: true,
                availableBalance: true,
                frozenBalance: true,
                createdAt: true,
                updatedAt: true,
            },
        });
    }

    /**
     * 查询当前用户流水（分页）
     * - 后续统计会基于 status 过滤（例如排除 REVERSED）
     * - 当前仅提供列表能力
     */
    async listMyTransactions(userId: number, query: QueryWalletTransactionsDto) {
        if (!userId) throw new BadRequestException('无效的 userId');

        const page = Math.max(1, Number(query.page ?? 1));
        const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
        const skip = (page - 1) * limit;

        const where: any = { userId };

        if (query.status) where.status = query.status;
        if (query.bizType) where.bizType = query.bizType;
        if (query.direction) where.direction = query.direction;
        if (query.orderId) where.orderId = Number(query.orderId);
        if (query.dispatchId) where.dispatchId = Number(query.dispatchId);

        // 时间范围（createdAt）
        if (query.startAt || query.endAt) {
            where.createdAt = {};
            if (query.startAt) where.createdAt.gte = new Date(query.startAt);
            if (query.endAt) where.createdAt.lte = new Date(query.endAt);
        }

        const [total, data] = await this.prisma.$transaction([
            this.prisma.walletTransaction.count({ where }),
            this.prisma.walletTransaction.findMany({
                where,
                orderBy: { id: 'desc' },
                skip,
                take: limit,
                select: {
                    id: true,
                    userId: true,
                    direction: true,
                    bizType: true,
                    amount: true,
                    status: true,
                    sourceType: true,
                    sourceId: true,
                    orderId: true,
                    dispatchId: true,
                    settlementId: true,
                    reversalOfTxId: true,
                    createdAt: true,
                },
            }),
        ]);

        return { data, total, page, limit };
    }

    /**
     * 查询当前用户冻结单（分页）
     */
    async listMyHolds(userId: number, query: QueryWalletHoldsDto) {
        if (!userId) throw new BadRequestException('无效的 userId');

        const page = Math.max(1, Number(query.page ?? 1));
        const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
        const skip = (page - 1) * limit;

        const where: any = { userId };
        if (query.status) where.status = query.status;

        const [total, data] = await this.prisma.$transaction([
            this.prisma.walletHold.count({ where }),
            this.prisma.walletHold.findMany({
                where,
                orderBy: { unlockAt: 'asc' },
                skip,
                take: limit,
                select: {
                    id: true,
                    userId: true,
                    earningTxId: true,
                    amount: true,
                    status: true,
                    unlockAt: true,
                    createdAt: true,
                    releasedAt: true,
                },
            }),
        ]);

        return { data, total, page, limit };
    }

}
