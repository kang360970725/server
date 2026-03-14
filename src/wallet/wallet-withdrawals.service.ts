import {BadRequestException, ForbiddenException, Injectable} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {tcbGetTempFileURL} from "../common/cloudbase.storage";
import { WalletDepositService } from './wallet.deposit.service';

/** ✅ 截断到 2 位小数（不四舍五入） */
const round2 = (v: any): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.trunc(n * 100) / 100;
};

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
    constructor(
        private readonly prisma: PrismaService,
        private readonly walletDepositService: WalletDepositService,
    ) {}

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
     * ✅ 获取提现相关信息
     * 用于前端提现弹窗计算押金
     */
    async getWithdrawInfo(userId: number) {

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                depositLimit: true,
                walletAccount: {
                    select: {
                        availableBalance: true,
                        depositBalance: true,
                    },
                },
            },
        });

        if (!user) {
            throw new BadRequestException('用户不存在');
        }

        return {
            availableBalance: Number(user.walletAccount?.availableBalance || 0),
            depositBalance: Number(user.walletAccount?.depositBalance || 0),
            depositLimit: Number(user.depositLimit || 500),
        };
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
            throw new BadRequestException('提现金额必须大于 0');
        }

        return this.prisma.$transaction(async (tx) => {

            // =========================
            // Step 0：读取用户信息
            // =========================
            const u = await tx.user.findUnique({
                where: { id: userId },
                select: {
                    withdrawQrCodeKey: true,
                    canWithdraw: true,
                    userType: true,
                    depositLimit: true,
                },
            });

            if (!u) throw new BadRequestException('用户不存在');

            if (!u.canWithdraw) {
                throw new BadRequestException('当前账户暂不允许提现');
            }

            if (!u.withdrawQrCodeKey) {
                throw new BadRequestException('请先上传收款二维码');
            }

            const isStaff = u.userType === 'STAFF';

            // =========================
            // Step 1：提现次数限制
            // =========================
            const now = new Date();

            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
            const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

            const dayCount = await tx.walletWithdrawalRequest.count({
                where: {
                    userId,
                    createdAt: {
                        gte: startOfDay,
                        lte: endOfDay,
                    },
                },
            });

            if (dayCount >= 1) {
                throw new BadRequestException('每天只能申请提现 1 次');
            }

            const day = now.getDay() || 7;
            const startOfWeek = new Date(now);
            startOfWeek.setDate(now.getDate() - day + 1);
            startOfWeek.setHours(0, 0, 0, 0);

            const endOfWeek = new Date(startOfWeek);
            endOfWeek.setDate(startOfWeek.getDate() + 6);
            endOfWeek.setHours(23, 59, 59, 999);

            const weekCount = await tx.walletWithdrawalRequest.count({
                where: {
                    userId,
                    createdAt: {
                        gte: startOfWeek,
                        lte: endOfWeek,
                    },
                },
            });

            if (weekCount >= 3) {
                throw new BadRequestException('每周最多提现 3 次');
            }

            // =========================
            // Step 1.5：首次提现限制
            // =========================
            const historyCount = await tx.walletWithdrawalRequest.count({
                where: { userId },
            });

            if (historyCount === 0 && isStaff) {

                const firstDispatch = await tx.orderParticipant.findFirst({
                    where: { userId },
                    orderBy: { acceptedAt: 'asc' },
                    select: { acceptedAt: true },
                });

                if (!firstDispatch) {
                    throw new BadRequestException('未接单用户暂不能提现');
                }

                const days = Math.floor(
                    (Date.now() - new Date(firstDispatch.acceptedAt).getTime()) /
                    (1000 * 60 * 60 * 24)
                );

                if (days < 15) {
                    throw new BadRequestException('首次提现需接单满15天');
                }

                const accountCheck = await tx.walletAccount.findUnique({
                    where: { userId },
                    select: { availableBalance: true },
                });

                if (Number(accountCheck?.availableBalance || 0) < 1000 && isStaff) {
                    throw new BadRequestException('首次提现余额需达到 1000');
                }
            }

            // =========================
            // Step 2：钱包校验
            // =========================
            const account = await tx.walletAccount.findUnique({
                where: { userId },
            });

            if (!account) throw new BadRequestException('钱包账户不存在');

            const available = Number(account.availableBalance || 0);

            if (available < amount) {
                throw new BadRequestException('可用余额不足');
            }

            if (available < 0) {
                throw new BadRequestException('账户存在欠款，请先补齐');
            }

            // =========================
            // Step 3：计算押金
            // =========================
            let depositAdd = 0;

            if (isStaff) {
                const depositLimit = Number(u.depositLimit || 2000);
                const currentDeposit = Number(account.depositBalance || 0);

                const depositNeed = depositLimit - currentDeposit;

                if (depositNeed > 0) {

                    const depositByRate = Math.floor(amount * 0.1);

                    depositAdd = Math.min(depositByRate, depositNeed);
                }
            }

            const withdrawAmount = amount - depositAdd;

            // =========================
            // Step 4：更新钱包
            // =========================
            const accountAfterUpdate = await tx.walletAccount.update({
                where: { userId },
                data: {
                    availableBalance: { decrement: amount },
                    depositBalance: { increment: depositAdd },
                    frozenBalance: { increment: withdrawAmount },
                },
                select: {
                    availableBalance: true,
                    frozenBalance: true,
                },
            });

            // =========================
            // Step 5：押金流水
            // =========================
            if (depositAdd) {
                await tx.walletDepositTransaction.create({
                    data: {
                        userId,
                        amount: depositAdd,
                        bizType: 'WITHDRAW_PERCENT',
                        remark: '提现自动缴纳押金',
                    },
                });
            }

            // =========================
            // Step 6：提现冻结流水
            // =========================
            const reserveTx = await tx.walletTransaction.create({
                data: {
                    userId,
                    direction: 'OUT',
                    bizType: 'WITHDRAW_RESERVE',
                    amount: withdrawAmount,
                    status: 'FROZEN',
                    sourceType: 'WITHDRAWAL_REQUEST',
                    sourceId: 0,
                    availableAfter: round2(Number(accountAfterUpdate.availableBalance || 0)),
                    frozenAfter: round2(Number(accountAfterUpdate.frozenBalance || 0)),
                },
            });

            // =========================
            // Step 7：创建提现申请
            // =========================
            const requestNo = this.genRequestNo();

            const request = await tx.walletWithdrawalRequest.create({
                data: {
                    userId,
                    amount: withdrawAmount,
                    status: 'PENDING_REVIEW',
                    channel,
                    idempotencyKey,
                    requestNo,
                    remark,
                    reserveTxId: reserveTx.id,
                },
            });

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
            if (!req) throw new BadRequestException('提现申请不存在');

            // ✅ 幂等：终态直接返回，避免重复扣减/重复流水
            if (req.status === 'PAID' || req.status === 'REJECTED') return req;

            if (req.status !== 'PENDING_REVIEW') {
                throw new BadRequestException('该提现申请不在待审核状态');
            }

            const now = new Date();

            // ===========================
            // ✅ 审批通过：当前阶段按“通过即出款完成”处理（最小改动）
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
                    const accountAfterPayout = await tx.walletAccount.update({
                        where: { userId: req.userId },
                        data: {
                            frozenBalance: { decrement: req.amount },
                            // availableBalance 不动（因为申请时就已扣过 available）
                        },
                        select: { availableBalance: true, frozenBalance: true },
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
                            // ✅ 余额快照（本笔出款后的余额）
                            availableAfter: round2(Number((accountAfterPayout as any).availableBalance ?? 0)),
                            frozenAfter: round2(Number((accountAfterPayout as any).frozenBalance ?? 0)),
                        },
                        update: {
                            direction: 'OUT',
                            bizType: 'WITHDRAW_PAYOUT',
                            amount: req.amount,
                            status: 'AVAILABLE',
                            availableAfter: round2(Number((accountAfterPayout as any).availableBalance ?? 0)),
                            frozenAfter: round2(Number((accountAfterPayout as any).frozenBalance ?? 0)),
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
                const accountAfterRelease = await tx.walletAccount.update({
                    where: { userId: req.userId },
                    data: {
                        frozenBalance: { decrement: req.amount },
                        availableBalance: { increment: req.amount },
                    },
                    select: { availableBalance: true, frozenBalance: true },
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
                        // ✅ 余额快照（本笔退回后的余额）
                        availableAfter: round2(Number((accountAfterRelease as any).availableBalance ?? 0)),
                        frozenAfter: round2(Number((accountAfterRelease as any).frozenBalance ?? 0)),
                    },
                    update: {
                        direction: 'IN',
                        bizType: 'WITHDRAW_RELEASE',
                        amount: req.amount,
                        status: 'AVAILABLE',
                        availableAfter: round2(Number((accountAfterRelease as any).availableBalance ?? 0)),
                        frozenAfter: round2(Number((accountAfterRelease as any).frozenBalance ?? 0)),
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

    /** 管理端：待审核列表（带用户昵称 + 钱包余额 + 收款码临时URL） */
    async listPending() {
        const where = { status: 'PENDING_REVIEW' as any };

        const [count, aggregate, list] = await this.prisma.$transaction([
            this.prisma.walletWithdrawalRequest.count({ where }),
            this.prisma.walletWithdrawalRequest.aggregate({
                where,
                _sum: { amount: true },
            }),
            this.prisma.walletWithdrawalRequest.findMany({
                where,
                orderBy: { id: 'asc' },
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,
                            realName: true,
                            withdrawQrCodeKey: true,
                        },
                    },
                },
            }),
        ]);

        const enriched = await Promise.all(
            list.map(async (r: any) => {
                const wallet = await this.prisma.walletAccount.findUnique({
                    where: { userId: r.userId },
                    select: { availableBalance: true, frozenBalance: true },
                });

                let withdrawQrCodeUrl: string | null = null;
                const cloudObjectId = r?.user?.withdrawQrCodeKey;
                if (cloudObjectId) {
                    withdrawQrCodeUrl = await tcbGetTempFileURL({
                        cloudPath: cloudObjectId,
                        maxAgeSeconds: 600,
                    });
                }

                return {
                    ...r,
                    wallet: wallet || { availableBalance: 0, frozenBalance: 0 },
                    withdrawQrCodeUrl: withdrawQrCodeUrl || null,
                };
            }),
        );

        return {
            count,
            totalAmount: aggregate._sum.amount || 0,
            list: enriched,
        };
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

        const take = Math.max(1, Math.min(Number(pageSize) || 20, 200));
        const skip = (Math.max(1, Number(page) || 1) - 1) * take;

        const where: any = {};

        if (status) where.status = status;
        if (channel) where.channel = channel;
        if (userId) where.userId = Number(userId);

        if (requestNo && String(requestNo).trim()) {
            where.requestNo = { contains: String(requestNo).trim() };
        }

        // ===============================
        // 时间维度：使用 reviewedAt
        // 默认本月（北京时间）
        // ===============================

        const now = new Date();

        let fromDate: Date | null = null;
        let toDate: Date | null = null;

        if (createdAtFrom || createdAtTo) {
            if (createdAtFrom) fromDate = new Date(createdAtFrom);
            if (createdAtTo) toDate = new Date(createdAtTo);
        } else {
            // 默认本月（北京时间）
            const year = now.getFullYear();
            const month = now.getMonth();

            fromDate = new Date(year, month, 1, 0, 0, 0);
            toDate = new Date(year, month + 1, 0, 23, 59, 59);
        }

        if (fromDate || toDate) {
            where.reviewedAt = {};
            if (fromDate) where.reviewedAt.gte = fromDate;
            if (toDate) where.reviewedAt.lte = toDate;
        }

        // ===============================
        // 主查询
        // ===============================

        const [total, list, approvedAgg, paidAgg] = await this.prisma.$transaction([
            this.prisma.walletWithdrawalRequest.count({ where }),
            this.prisma.walletWithdrawalRequest.findMany({
                where,
                orderBy: { id: 'desc' },
                skip,
                take,
                include: {
                    user: {
                        select: {
                            id: true,
                            name: true,
                            realName: true,
                        },
                    },
                },
            }),
            // 已审核统计
            this.prisma.walletWithdrawalRequest.aggregate({
                where: {
                    ...where,
                    status: { in: ['APPROVED', 'PAYING', 'PAID', 'FAILED'] },
                },
                _sum: { amount: true },
                _count: true,
            }),
            // 已打款统计
            this.prisma.walletWithdrawalRequest.aggregate({
                where: {
                    ...where,
                    status: 'PAID',
                },
                _sum: { amount: true },
                _count: true,
            }),
        ]);

        return {
            total,
            list,
            page: Math.max(1, Number(page) || 1),
            pageSize: take,
            summary: {
                approvedAmount: approvedAgg._sum.amount || 0,
                approvedCount: approvedAgg._count || 0,
                paidAmount: paidAgg._sum.amount || 0,
                paidCount: paidAgg._count || 0,
            },
        };
    }


}
