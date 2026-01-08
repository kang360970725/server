import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * 提现服务（Wallet 子能力）
 *
 * 核心规则：
 * 1. 只能提现已解冻 availableBalance
 * 2. 申请即预扣（available -> frozen），防止并发重复申请
 * 3. 提现必须审批
 * 4. 为后续微信自动打款预留完整状态与字段
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
     * 1. 校验可用余额
     * 2. 预扣资金（available -> frozen）
     * 3. 写冻结流水（WITHDRAW_RESERVE）
     * 4. 创建提现申请单（PENDING_REVIEW）
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

            if (account.availableBalance < amount) {
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
                data: {
                    sourceId: request.id,
                },
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

            if (req.status !== 'PENDING_REVIEW') {
                throw new Error('该提现申请不在待审核状态');
            }

            // ✅ 审批通过
            if (approve) {
                return tx.walletWithdrawalRequest.update({
                    where: { id: requestId },
                    data: {
                        status: 'APPROVED',
                        reviewedBy: reviewerId,
                        reviewedAt: new Date(),
                        reviewRemark,
                    },
                });
            }

            // ❌ 审批驳回：资金退回
            await tx.walletAccount.update({
                where: { userId: req.userId },
                data: {
                    frozenBalance: { decrement: req.amount },
                    availableBalance: { increment: req.amount },
                },
            });

            await tx.walletTransaction.create({
                data: {
                    userId: req.userId,
                    direction: 'IN',
                    bizType: 'WITHDRAW_RELEASE',
                    amount: req.amount,
                    status: 'AVAILABLE',
                    sourceType: 'WITHDRAWAL_REQUEST',
                    sourceId: req.id,
                },
            });

            return tx.walletWithdrawalRequest.update({
                where: { id: requestId },
                data: {
                    status: 'REJECTED',
                    reviewedBy: reviewerId,
                    reviewedAt: new Date(),
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
}
