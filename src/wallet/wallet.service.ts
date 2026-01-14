import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { Prisma, PrismaClient, WalletBizType, WalletDirection, WalletHoldStatus, WalletTxStatus,  } from '@prisma/client';
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
    async createFrozenSettlementEarning(
        params: {
            userId: number;
            amount: number;
            unlockAt: Date;

            // 幂等来源
            sourceType?: string; // default 'ORDER_SETTLEMENT'
            sourceId: number;

            // ✅ 是否允许“重算修正”（由 Orders 侧 canRecalc 传入）
            // - true：若 earningTx 仍为 FROZEN，则允许将 tx/hold 金额与解冻时间对齐到最新，并修正 frozenBalance（按 delta）
            // - false：只做幂等补偿（补建 hold），不改金额（避免覆盖人工调整/已支付/已出账等）
            allowRecalc?: boolean;

            // 可选冗余关联，方便对账
            orderId?: number | null;
            dispatchId?: number | null;
            settlementId?: number | null; // 对应 OrderSettlement.id
        },
        tx?: PrismaTx,
    ) {
        console.log(
            '[createFrozenSettlementEarning] userId=',
            params.userId,
            'amount=',
            params.amount,
            'sourceType=',
            params.sourceType ?? 'ORDER_SETTLEMENT',
            'sourceId=',
            params.sourceId,
            'allowRecalc=',
            params.allowRecalc ?? false,
        );

        const db = (tx as any) ?? this.prisma;

        const sourceType = params.sourceType ?? 'ORDER_SETTLEMENT';
        const allowRecalc = params.allowRecalc ?? false;

        // ✅ 金额统一保留两位（你原实现）
        const amount = round2(params.amount);

        if (amount <= 0) {
            // 结算收益为 0 的情况：不入账、不建冻结单（避免产生无意义流水）
            return { created: false, updated: false, tx: null as any, hold: null as any };
        }

        // 说明：
        // - 这套链路的幂等锚点是：WalletTransaction.(sourceType, sourceId) 的唯一约束
        // - WalletHold 则以 earningTxId @unique 做第二层幂等（同一收益流水只能冻结一次）
        //
        // 所以最稳的做法是：
        // 1) upsert WalletTransaction（消灭并发竞态）
        // 2) upsert WalletHold（消灭并发竞态）
        // 3) 账户汇总 frozenBalance 用“delta 修正”或“补偿修正”，确保一致

        const runner = async (t: PrismaTx) => {
            // 0) 兜底确保账户存在
            await this.ensureWalletAccount(params.userId, t as any);

            // 1) upsert 收益流水（冻结）
            // ✅ 幂等：同一来源只会有一条收益流水
            //
            // 注意：
            // - create 分支：正常创建冻结流水
            // - update 分支：只更新冗余字段；金额是否更新由 allowRecalc + status 决定（后面统一处理）
            const earningTx = await (t as any).walletTransaction.upsert({
                where: {
                    // @@unique([sourceType, sourceId])
                    sourceType_sourceId: {
                        sourceType,
                        sourceId: params.sourceId,
                    },
                },
                create: {
                    userId: params.userId,
                    direction: 'IN',
                    bizType: 'SETTLEMENT_EARNING',
                    amount, // 初始金额
                    status: 'FROZEN',
                    sourceType,
                    sourceId: params.sourceId,
                    orderId: params.orderId ?? null,
                    dispatchId: params.dispatchId ?? null,
                    settlementId: params.settlementId ?? null,
                },
                update: {
                    // ✅ 幂等补偿：冗余字段可以对齐（不敏感）
                    // ⚠️ 金额是否改，后面统一按 allowRecalc + status 判断
                    orderId: params.orderId ?? null,
                    dispatchId: params.dispatchId ?? null,
                    settlementId: params.settlementId ?? null,
                },
                select: { id: true, userId: true, amount: true, status: true },
            });

            // 2) 确保冻结单存在（upsert）
            //    WalletHold 以 earningTxId @unique 幂等
            const existingHold = await (t as any).walletHold.findUnique({
                where: { earningTxId: earningTx.id },
                select: { id: true, amount: true, status: true, unlockAt: true },
            });

            // 3) 处理三类情况：
            // A) 第一次创建（earningTx.status=FROZEN + hold 不存在）
            // B) 已存在但需要补偿（hold 缺失）
            // C) 已存在且 allowRecalc=true，需要同步金额与解冻时间（仅当 earningTx 仍为 FROZEN）
            //
            // 核心原则：
            // - 如果 earningTx 不为 FROZEN，说明这笔流水已进入后续流程（解冻/出账/冲正等），不要再改金额，避免污染财务链路
            // - 如果 allowRecalc=false，则永远不改金额，只做“补建/补偿”
            let created = false;
            let updated = false;

            // ---------- 3.1) 补建冻结单 ----------
            // 这里必须非常小心 frozenBalance 的补偿增量应当用“真实冻结金额”
            // - 若已有 earningTx，冻结金额应以 earningTx.amount 为准（不是 params.amount）
            if (!existingHold) {
                const hold = await (t as any).walletHold.create({
                    data: {
                        userId: params.userId,
                        earningTxId: earningTx.id,
                        amount: earningTx.amount, // ✅ 以 earningTx.amount 为准，避免补偿时用错 params.amount
                        status: 'FROZEN',
                        unlockAt: params.unlockAt,
                    },
                    select: { id: true, amount: true, status: true, unlockAt: true },
                });

                // 冻结单补建时，账户 frozenBalance 可能没加过，这里做一次兜底修正：
                // - 只有当收益流水还是 FROZEN 时才补增 frozenBalance
                if (earningTx.status === 'FROZEN') {
                    await (t as any).walletAccount.update({
                        where: { userId: params.userId },
                        data: { frozenBalance: { increment: earningTx.amount } },
                    });
                }

                // ✅ 这属于“补偿创建”
                return { created: false, updated: true, tx: earningTx, hold };
            }

            // ---------- 3.2) allowRecalc：同步修正金额 / 解冻时间 ----------
            // 只有在满足以下条件时才允许对齐金额：
            // - allowRecalc=true（Orders 侧判断了 canRecalc）
            // - earningTx.status === 'FROZEN'（仍在冻结态，可安全调整）
            //
            // 对齐内容：
            // - WalletTransaction.amount -> amount
            // - WalletHold.amount -> amount
            // - WalletHold.unlockAt -> params.unlockAt（体验/非体验规则调整也要对齐）
            // - walletAccount.frozenBalance 按 delta 修正
            if (allowRecalc && earningTx.status === 'FROZEN') {
                const oldAmount = round2(earningTx.amount);
                const newAmount = amount;

                // delta 可正可负
                const delta = round2(newAmount - oldAmount);

                // 如果金额或 unlockAt 有变化才更新（减少写压力）
                const needUpdateAmount = delta !== 0;
                const needUpdateUnlockAt =
                    existingHold.unlockAt?.getTime?.() !== params.unlockAt.getTime?.();

                if (needUpdateAmount || needUpdateUnlockAt) {
                    if (needUpdateAmount) {
                        await (t as any).walletTransaction.update({
                            where: { id: earningTx.id },
                            data: { amount: newAmount },
                        });

                        // ✅ 汇总账户 frozenBalance 按差额修正
                        // - 增加：increment
                        // - 减少：decrement
                        if (delta > 0) {
                            await (t as any).walletAccount.update({
                                where: { userId: params.userId },
                                data: { frozenBalance: { increment: delta } },
                            });
                        } else if (delta < 0) {
                            await (t as any).walletAccount.update({
                                where: { userId: params.userId },
                                data: { frozenBalance: { decrement: Math.abs(delta) } },
                            });
                        }
                    }

                    await (t as any).walletHold.update({
                        where: { id: existingHold.id },
                        data: {
                            amount: newAmount, // ✅ 冻结单金额同步
                            unlockAt: params.unlockAt, // ✅ 解冻时间同步
                        },
                    });

                    updated = true;
                }

                // 返回最新 hold（保持返回值可信）
                const hold = await (t as any).walletHold.findUnique({
                    where: { id: existingHold.id },
                    select: { id: true, amount: true, status: true, unlockAt: true },
                });

                // 返回最新 tx（金额可能已更新）
                const txLatest = await (t as any).walletTransaction.findUnique({
                    where: { id: earningTx.id },
                    select: { id: true, userId: true, amount: true, status: true },
                });

                return { created, updated, tx: txLatest, hold };
            }

            // ---------- 3.3) 默认幂等返回（不改金额） ----------
            // allowRecalc=false 或 earningTx.status != FROZEN
            // 只保证“冻结单存在”，并返回
            const hold = await (t as any).walletHold.findUnique({
                where: { id: existingHold.id },
                select: { id: true, amount: true, status: true, unlockAt: true },
            });

            return { created, updated, tx: earningTx, hold };
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
                walletUid: true,
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

        // 1) 组 where（WalletTransaction）
        const where: any = { userId };

        if (query.direction) where.direction = query.direction;
        if (query.bizType) where.bizType = query.bizType;
        if (query.status) where.status = query.status;

        // 你原本有重复设置，这里保留也不影响，但建议去掉重复
        if (query.orderId) where.orderId = Number(query.orderId);
        if (query.dispatchId) where.dispatchId = Number(query.dispatchId);

        // 时间范围（createdAt）
        if (query.startAt || query.endAt) {
            where.createdAt = {};
            if (query.startAt) where.createdAt.gte = new Date(query.startAt);
            if (query.endAt) where.createdAt.lte = new Date(query.endAt);
        }

        // ✅ 2) 先查当前账户余额（作为“本页最新余额锚点”）
        await this.ensureWalletAccount(userId, this.prisma as any);
        const accountNow = await this.prisma.walletAccount.findUnique({
            where: { userId },
            select: { availableBalance: true, frozenBalance: true },
        });

        const [total, rows] = await this.prisma.$transaction([
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

        // ✅ 3) 计算每条流水对 “available / frozen” 的影响（用 bizType，不用 status）
        const toNum = (v: any) => {
            const n = Number(v ?? 0);
            return Number.isFinite(n) ? n : 0;
        };

        const calcDelta = (tx: any) => {
            const amt = toNum(tx.amount);
            const biz = tx.bizType;

            // 默认无影响
            let deltaAvailable = 0;
            let deltaFrozen = 0;

            // 已冲正/无效：不影响余额（避免脏数据干扰）
            if (tx.status === 'REVERSED') {
                return { deltaAvailable: 0, deltaFrozen: 0 };
            }

            // ✅ 结算收益：事件发生时“先冻结”（即便后来 status 被改成 AVAILABLE，也不改这条的余额口径）
            if (
                biz === 'SETTLEMENT_EARNING' ||
                biz === 'SETTLEMENT_EARNING_BASE' ||
                biz === 'SETTLEMENT_EARNING_CARRY' ||
                biz === 'SETTLEMENT_EARNING_CS'
            ) {
                // 你的结算收益目前 amount 永远正数；冻结就是 frozen += amount
                // 如果未来你有负向收益 tx（OUT/AVAILABLE），那应走 BOMB_LOSS 或另外的 bizType
                if (tx.direction === 'IN' && amt > 0) deltaFrozen += amt;
                return { deltaAvailable, deltaFrozen };
            }

            // ✅ 炸单损耗：即时扣款（可用余额减少）
            if (biz === 'SETTLEMENT_BOMB_LOSS') {
                // 统一按可用余额扣除（你已明确负数不冻结、即时纳入余额）
                if (amt > 0) deltaAvailable -= amt;
                return { deltaAvailable, deltaFrozen };
            }

            // ✅ 解冻入账：冻结转可用（你 releaseDueHoldsOnce 就是这个逻辑）
            if (biz === 'RELEASE_FROZEN') {
                if (amt > 0) {
                    deltaFrozen -= amt;
                    deltaAvailable += amt;
                }
                return { deltaAvailable, deltaFrozen };
            }

            // ✅ 提现：预扣（available -> frozen）
            if (biz === 'WITHDRAW_RESERVE') {
                if (amt > 0) {
                    deltaAvailable -= amt;
                    deltaFrozen += amt;
                }
                return { deltaAvailable, deltaFrozen };
            }

            // ✅ 提现：驳回/取消退回（frozen -> available）
            if (biz === 'WITHDRAW_RELEASE') {
                if (amt > 0) {
                    deltaFrozen -= amt;
                    deltaAvailable += amt;
                }
                return { deltaAvailable, deltaFrozen };
            }

            // ✅ 提现：出款成功（冻结真正扣除）
            if (biz === 'WITHDRAW_PAYOUT') {
                if (amt > 0) {
                    deltaFrozen -= amt;
                }
                return { deltaAvailable, deltaFrozen };
            }

            // ✅ 退款冲正（对冲收益）：通常是可用余额减少 or 冻结减少，取决于你怎么落账
            // 这里先按 direction 来做通用口径（你后面如果要更严格，可单独约束）
            if (biz === 'REFUND_REVERSAL') {
                if (amt > 0) {
                    if (tx.direction === 'IN') deltaAvailable += amt;
                    if (tx.direction === 'OUT') deltaAvailable -= amt;
                }
                return { deltaAvailable, deltaFrozen };
            }

            return { deltaAvailable, deltaFrozen };
        };

        // ✅ 4) 从“当前余额”倒推本页每条 before/after（只保证本页内一致）
        // 说明：这是“本页视角”的余额快照，老于本页的记录未纳入回算，所以最老一条的 before 不等于真实历史余额。
        // 但对“微信式展示”已经足够（尤其 page=1 的体验最好）。
        let availAfter = toNum(accountNow?.availableBalance);
        let frozenAfter = toNum(accountNow?.frozenBalance);

        const enriched = rows.map((r: any) => {
            const { deltaAvailable, deltaFrozen } = calcDelta(r);

            const availableAfter = availAfter;
            const frozenAfterV = frozenAfter;

            const availableBefore = Number((availableAfter - deltaAvailable).toFixed(2));
            const frozenBefore = Number((frozenAfterV - deltaFrozen).toFixed(2));

            // 下一条（更老）以本条 before 作为 after
            availAfter = availableBefore;
            frozenAfter = frozenBefore;

            return {
                ...r,
                deltaAvailable,
                deltaFrozen,

                availableBefore,
                availableAfter,
                frozenBefore,
                frozenAfter: frozenAfterV,

                balanceBefore: Number((availableBefore + frozenBefore).toFixed(2)),
                balanceAfter: Number((availableAfter + frozenAfterV).toFixed(2)),
            };
        });

        return {
            data: enriched,
            total,
            page,
            limit,
            accountNow: {
                availableBalance: toNum(accountNow?.availableBalance),
                frozenBalance: toNum(accountNow?.frozenBalance),
                balance: Number((toNum(accountNow?.availableBalance) + toNum(accountNow?.frozenBalance)).toFixed(2)),
            },
        };
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

    /**
     * ✅ 将某一条 OrderSettlement（sourceType+sourceId）对应的钱包流水与冻结单同步到指定 finalEarnings
     * - finalEarnings > 0：IN + FROZEN + hold(FROZEN)，影响 frozenBalance
     * - finalEarnings = 0：REVERSED，释放/取消 hold，回滚 frozenBalance / availableBalance 影响
     * - finalEarnings < 0：OUT + AVAILABLE（立刻扣款），取消 hold，影响 availableBalance（实时）
     *
     * ⚠️ 不新增流水：始终 upsert 同一条 WalletTransaction（uniq_wallet_tx_source）
     */
    async syncSettlementEarningByFinalEarnings(
        params: {
            userId: number;
            finalEarnings: number; // ✅ 允许负数
            unlockAt?: Date; // 仅在需要补建冻结单且 final>0 时使用
            sourceType?: string; // default ORDER_SETTLEMENT
            sourceId: number; // settlementId
            // ✅ 新增：业务类型（默认基础结算收益）
            bizType?: WalletBizType;

            orderId?: number | null;
            dispatchId?: number | null;
            settlementId?: number | null;
        },
        tx?: PrismaTx,
    ) {

        const db = (tx as any) ?? this.prisma;
        const sourceType = params.sourceType ?? 'ORDER_SETTLEMENT';

        const bizType = params.bizType ?? WalletBizType.SETTLEMENT_EARNING_BASE;

        // ✅ 方向 + 金额归一：finalEarnings 可以是负数
        const raw = Number(params.finalEarnings ?? 0);
        if (!Number.isFinite(raw)) throw new BadRequestException('finalEarnings 非法');

        const final = this.trunc1(Number(params.finalEarnings ?? 0));
        const absAmt = this.trunc1(Math.abs(final));

        // ✅ 兜底确保账户存在
        await this.ensureWalletAccount(params.userId, db as any);

        const now = new Date();

        // 1) 锁定/获取现有 tx（同一来源唯一）
        const existingTx = await db.walletTransaction.findUnique({
            where: {
                sourceType_sourceId: {
                    sourceType,
                    sourceId: params.sourceId,
                },
            },
            select: { id: true, userId: true, amount: true, status: true, direction: true },
        });

        // 2) 若存在 tx，则查对应 hold（可能缺失）
        const existingHold = existingTx
            ? await db.walletHold.findUnique({
                where: { earningTxId: existingTx.id },
                select: { id: true, amount: true, status: true, unlockAt: true },
            })
            : null;

        // 3) 计算旧影响（用于 delta 修正账户汇总）
        const oldAmount = round2(Number(existingTx?.amount ?? 0));
        const oldFrozen = existingTx?.status === 'FROZEN' ? oldAmount : 0;

        const oldAvailImpact =
            existingTx?.status === 'AVAILABLE'
                ? existingTx.direction === 'IN'
                ? oldAmount
                : existingTx.direction === 'OUT'
                    ? -oldAmount
                    : 0
                : 0;

        // 4) 计算新目标状态
        let newStatus: WalletTxStatus;
        let newDirection: WalletDirection;
        let newAmount: number;

        // ✅ newFrozen / newAvailImpact 用于账户 delta
        let newFrozen = 0;
        let newAvailImpact = 0;

        if (final > 0) {
            newStatus = 'FROZEN';
            newDirection = 'IN';
            newAmount = absAmt;
            newFrozen = newAmount;
            newAvailImpact = 0;
        } else if (final === 0) {
            // 你要“无冻结逻辑+不影响余额”，最干净就是标记 REVERSED 并释放 hold
            newStatus = 'REVERSED';
            newDirection = 'IN';
            newAmount = 0;
            newFrozen = 0;
            newAvailImpact = 0;
        } else {
            // final < 0：罚款/赔付
            // ✅ 不冻结，立刻纳入可用余额（等价于扣款）
            newStatus = 'AVAILABLE';
            newDirection = 'OUT';
            newAmount = absAmt;
            newFrozen = 0;
            newAvailImpact = -newAmount;
        }

        const deltaFrozen = round2(newFrozen - oldFrozen);
        const deltaAvail = round2(newAvailImpact - oldAvailImpact);
        // 5) upsert / update WalletTransaction（不新增第二条）
        // ✅ 如果已存在 tx，但 userId 不一致，直接报错（避免串账）
        if (existingTx && existingTx.userId !== params.userId) {
            throw new ConflictException('钱包流水来源已存在但用户不一致，疑似串账，请联系管理员处理');
        }

        const earningTx = await db.walletTransaction.upsert({
            where: {
                sourceType_sourceId: {
                    sourceType,
                    sourceId: params.sourceId,
                },
            },
            create: {
                userId: params.userId,
                direction: newDirection,
                bizType,
                amount: newAmount,
                status: newStatus,
                sourceType,
                sourceId: params.sourceId,
                orderId: params.orderId ?? null,
                dispatchId: params.dispatchId ?? null,
                settlementId: params.settlementId ?? params.sourceId,
            },
            update: {
                // ✅ 关键：bizType 必须允许被重算时更新，否则前端永远看不到区分
                bizType,

                // ✅ 再次对齐（避免历史错误）
                userId: params.userId,

                direction: newDirection,
                status: newStatus,
                amount: newAmount,

                // 冗余字段对齐
                orderId: params.orderId ?? null,
                dispatchId: params.dispatchId ?? null,
                settlementId: params.settlementId ?? params.sourceId,
            },
            select: { id: true, amount: true, status: true, direction: true, bizType: true },
        });

        // 6) 处理冻结单（hold）
        if (final > 0) {
            // ✅ 需要冻结：hold(FROZEN) 必须存在
            // - 已有 hold：沿用原 unlockAt（避免手动调整时改变冻结到期）
            // - 没有 hold：必须传 unlockAt（避免错误默认 now 立即解冻）
            const unlockAt = existingHold?.unlockAt ?? params.unlockAt;
            if (!unlockAt) {
                throw new BadRequestException('缺少 unlockAt：首次创建冻结收益时必须提供解冻时间');
            }

            await db.walletHold.upsert({
                where: { earningTxId: earningTx.id },
                create: {
                    userId: params.userId,
                    earningTxId: earningTx.id,
                    amount: newAmount,
                    status: 'FROZEN',
                    unlockAt,
                },
                update: {
                    amount: newAmount,
                    status: 'FROZEN',
                    unlockAt,
                    releasedAt: null,
                },
            });
        } else {
            // ✅ final <= 0：不应存在冻结（删除更稳，避免写不存在的枚举状态）
            if (existingHold) {
                await db.walletHold.delete({
                    where: { id: existingHold.id },
                });
            }
        }

        // 7) 同步账户汇总（按 delta 修正，保证一致）
        // frozenBalance：按 deltaFrozen 增减
        if (deltaFrozen !== 0) {
            if (deltaFrozen > 0) {
                await db.walletAccount.update({
                    where: { userId: params.userId },
                    data: { frozenBalance: { increment: deltaFrozen } },
                });
            } else {
                await db.walletAccount.update({
                    where: { userId: params.userId },
                    data: { frozenBalance: { decrement: Math.abs(deltaFrozen) } },
                });
            }
        }

        // availableBalance：按 deltaAvail 增减（负数就是扣款）
        if (deltaAvail !== 0) {
            if (deltaAvail > 0) {
                await db.walletAccount.update({
                    where: { userId: params.userId },
                    data: { availableBalance: { increment: deltaAvail } },
                });
            } else {
                await db.walletAccount.update({
                    where: { userId: params.userId },
                    data: { availableBalance: { decrement: Math.abs(deltaAvail) } },
                });
            }
        }

        return { tx: earningTx };
    }


    /** ✅ 截断到 1 位小数（不四舍五入） */
    private trunc1(v: any): number {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;

        // 1位：乘10后截断再除10
        // 注意：Math.trunc 对负数也是“向0截断”，符合“舍弃”直觉
        return Math.trunc(n * 10) / 10;
    }

}
