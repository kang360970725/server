import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * 提现服务（Wallet 子能力）
 *
 * 核心规则：
 * 1) 只能提现已解冻 availableBalance
 * 2) 申请即预扣（available -> frozen），防止并发重复申请
 * 3) 提现必须审批
 * 4) 为后续微信自动打款预留完整状态与字段
 */
@Injectable()
export class WalletWithdrawalsService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * 生成展示/对账用提现单号
     * 可替换为你现有的流水号生成规则
     */
    private genRequestNo() {
        const now = new Date();
        const y = now.getFullYear().toString().slice(2);
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const rand = Math.random().toString(16).slice(2, 10).toUpperCase();
        return `WD${y}${m}${d}${rand}`;
    }

    /**
     * ✅ 提现申请
     *
     * 流程：
     * 1) 校验可用余额
     * 2) 预扣资金（available -> frozen）
     * 3) 写冻结流水（WITHDRAW_RESERVE）
     * 4) 创建提现申请单（PENDING_REVIEW）
     *
     * 幂等：
     * - 前端必须传 idempotencyKey
     * - DB 有 uniq(userId, idempotencyKey) 兜底
     */
    async applyWithdrawal(params: {
        userId: number;
        amount: number;
        idempotencyKey: string;
        remark?: string;
        channel?: 'MANUAL' | 'WECHAT';
    }) {
        const { userId, amount, idempotencyKey, remark, channel = 'MANUAL' } = params;

        if (!amount || amount <= 0) {
            throw new Error('提现金额必须大于 0');
        }

        return this.prisma.$transaction(async (tx) => {
            // 1️⃣ 校验钱包
            const account = await tx.walletAccount.findUnique({ where: { userId } });
            if (!account) throw new Error('钱包账户不存在');
            if (Number((account as any).availableBalance ?? 0) < Number(amount ?? 0)) {
                throw new Error('可用余额不足（仅可提现已解冻余额）');
            }

            // 2️⃣ 预扣资金（防并发）
            await tx.walletAccount.update({
                where: { userId },
                data: {
                    availableBalance: { decrement: amount },
                    frozenBalance: { increment: amount },
                },
            });

            // 3️⃣ 冻结流水（此时不是出款，只是“锁钱”）
            const reserveTx = await tx.walletTransaction.create({
                data: {
                    userId,
                    direction: 'OUT',
                    bizType: 'WITHDRAW_RESERVE',
                    amount,
                    status: 'FROZEN',
                    sourceType: 'WITHDRAWAL_REQUEST',
                    sourceId: 0, // 创建申请单后再回填
                },
            });

            // 4️⃣ 创建提现申请单
            const requestNo = this.genRequestNo();

            const request = await tx.walletWithdrawalRequest.create({
                data: {
                    userId,
                    amount,
                    status: 'PENDING_REVIEW',
                    channel,
                    idempotencyKey,
                    requestNo,
                    remark,
                    reserveTxId: reserveTx.id,
                },
            });

            // 5️⃣ 回填 sourceId，形成稳定业务锚点
            await tx.walletTransaction.update({
                where: { id: reserveTx.id },
                data: { sourceId: request.id },
            });

            return request;
        });
    }

    /**
     * ✅ 提现审批
     *
     * approve = true：
     * - 状态 -> APPROVED
     * - 资金仍冻结，等待打款
     *
     * approve = false：
     * - 状态 -> REJECTED
     * - 冻结资金退回可用
     */
    async reviewWithdrawal(params: {
        requestId: number;
        reviewerId: number;
        approve: boolean;
        reviewRemark?: string;
    }) {
        const { requestId, reviewerId, approve, reviewRemark } = params;

        return this.prisma.$transaction(async (tx) => {
            const req = await tx.walletWithdrawalRequest.findUnique({
                where: { id: requestId },
            });
            if (!req) throw new Error('提现申请不存在');

            // ✅ 幂等：终态直接返回，避免重复扣减/重复流水
            if (req.status === 'PAID' || req.status === 'REJECTED') return req;

            if (req.status !== 'PENDING_REVIEW') {
                throw new Error('该提现申请不在待审核状态');
            }

            const now = new Date();

            // ===========================
            // ✅ 审批通过：当前阶段按“通过即出款完成”处理（最小改动）
            // 目标：
            // 1) 冻结余额 frozenBalance 扣除（真正出款）
            // 2) 生成出款流水 WITHDRAW_PAYOUT（OUT, AVAILABLE）
            // 3) 申请单置为 PAID
            //
            // ⚠️ 前提：applyWithdrawal 阶段已经把资金从 available -> frozen 预扣了（WITHDRAW_RESERVE）
            //    如果你没做预扣，这里扣 frozen 会变成负数（需要你确认 applyWithdrawal 逻辑）
            // ===========================
            if (approve) {
                // 1) 幂等：是否已存在出款流水（避免重复扣 frozen）
                const PAYOUT_SOURCE_TYPE = 'WITHDRAWAL_REQUEST_PAYOUT';

                const existingPayout = await tx.walletTransaction.findUnique({
                    where: {
                        sourceType_sourceId: { sourceType: PAYOUT_SOURCE_TYPE, sourceId: req.id },
                    },
                    select: { id: true },
                });

                if (!existingPayout) {
                    // 2) 扣除冻结余额（真正扣款）
                    await tx.walletAccount.update({
                        where: { userId: req.userId },
                        data: {
                            frozenBalance: { decrement: req.amount },
                            // availableBalance 不动（因为申请时就已扣过 available）
                        },
                    });

                    // 3) 写出款流水（WITHDRAW_PAYOUT）
                    await tx.walletTransaction.upsert({
                        where: {
                            sourceType_sourceId: { sourceType: PAYOUT_SOURCE_TYPE, sourceId: req.id },
                        },
                        create: {
                            userId: req.userId,
                            direction: 'OUT',
                            bizType: 'WITHDRAW_PAYOUT',
                            amount: req.amount,
                            status: 'AVAILABLE', // ✅ 已完成的资金变动
                            sourceType: PAYOUT_SOURCE_TYPE,
                            sourceId: req.id,
                        },
                        update: {
                            direction: 'OUT',
                            bizType: 'WITHDRAW_PAYOUT',
                            amount: req.amount,
                            status: 'AVAILABLE',
                        },
                    });
                }

                // 4) 更新申请单为 PAID（并记录审核信息）
                return tx.walletWithdrawalRequest.update({
                    where: { id: requestId },
                    data: {
                        status: 'PAID', // ✅ 当前阶段：通过即视为已打款
                        reviewedBy: reviewerId,
                        reviewedAt: now,
                        reviewRemark,
                        // 如你有 paidAt 字段可加：paidAt: now
                    },
                });
            }

            // ===========================
            // ❌ 审批驳回：资金退回（frozen -> available）+ 幂等退回流水
            // ===========================
            const RELEASE_SOURCE_TYPE = 'WITHDRAWAL_REQUEST_RELEASE';

            // 1) 先查“退回流水”是否已存在：存在则说明已退回过，避免重复回滚余额
            const existingReleaseTx = await tx.walletTransaction.findUnique({
                where: {
                    sourceType_sourceId: { sourceType: RELEASE_SOURCE_TYPE, sourceId: req.id },
                },
                select: { id: true },
            });

            if (!existingReleaseTx) {
                // 2) 资金退回：frozen -amount, available +amount
                await tx.walletAccount.update({
                    where: { userId: req.userId },
                    data: {
                        frozenBalance: { decrement: req.amount },
                        availableBalance: { increment: req.amount },
                    },
                });

                // 3) 写退回流水（WITHDRAW_RELEASE）
                await tx.walletTransaction.upsert({
                    where: {
                        sourceType_sourceId: { sourceType: RELEASE_SOURCE_TYPE, sourceId: req.id },
                    },
                    create: {
                        userId: req.userId,
                        direction: 'IN',
                        bizType: 'WITHDRAW_RELEASE',
                        amount: req.amount,
                        status: 'AVAILABLE',
                        sourceType: RELEASE_SOURCE_TYPE,
                        sourceId: req.id,
                    },
                    update: {
                        direction: 'IN',
                        bizType: 'WITHDRAW_RELEASE',
                        amount: req.amount,
                        status: 'AVAILABLE',
                    },
                });
            }

            // 4) 更新申请单为 REJECTED
            return tx.walletWithdrawalRequest.update({
                where: { id: requestId },
                data: {
                    status: 'REJECTED',
                    reviewedBy: reviewerId,
                    reviewedAt: now,
                    reviewRemark,
                },
            });
        });
    }


    /** 打手端：我的提现记录 */
    async listMine(userId: number) {
        return this.prisma.walletWithdrawalRequest.findMany({
            where: { userId },
            orderBy: { id: 'desc' },
        });
    }

    /** 管理端：待审核列表 */
    async listPending() {
        return this.prisma.walletWithdrawalRequest.findMany({
            where: { status: 'PENDING_REVIEW' },
            orderBy: { id: 'asc' },
        });
    }

    /**
     * ✅ 管理端：全量记录（分页 + 筛选）
     * - 用于 admin 的“全部记录 + 状态筛选 + 打款结果字段展示”
     */
    async listAll(params: {
        page: number;
        pageSize: number;
        status?: string;
        channel?: string;
        userId?: number;
        requestNo?: string;
        createdAtFrom?: string;
        createdAtTo?: string;
    }) {
        const {
            page = 1,
            pageSize = 20,
            status,
            channel,
            userId,
            requestNo,
            createdAtFrom,
            createdAtTo,
        } = params || ({} as any);

        const take = Math.max(1, Math.min(Number(pageSize) || 20, 200)); // ✅ 单次最多 200，避免拖库
        const skip = (Math.max(1, Number(page) || 1) - 1) * take;

        // ✅ 组合 where 条件（全部可选）
        const where: any = {};

        if (status) where.status = status;
        if (channel) where.channel = channel;
        if (userId) where.userId = Number(userId);

        // ✅ requestNo 支持模糊（包含）
        if (requestNo && String(requestNo).trim()) {
            where.requestNo = { contains: String(requestNo).trim() };
        }

        // ✅ 时间范围过滤（createdAt）
        if (createdAtFrom || createdAtTo) {
            where.createdAt = {};
            if (createdAtFrom) where.createdAt.gte = new Date(createdAtFrom);
            if (createdAtTo) where.createdAt.lte = new Date(createdAtTo);
        }

        const [total, list] = await this.prisma.$transaction([
            this.prisma.walletWithdrawalRequest.count({ where }),
            this.prisma.walletWithdrawalRequest.findMany({
                where,
                orderBy: { id: 'desc' }, // ✅ 最新在前
                skip,
                take,
            }),
        ]);

        return { total, list, page: Math.max(1, Number(page) || 1), pageSize: take };
    }
}
