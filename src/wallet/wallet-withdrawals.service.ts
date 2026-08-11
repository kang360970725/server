import {BadRequestException, ForbiddenException, Injectable} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {tcbGetTempFileURL} from "../common/cloudbase.storage";
import { WalletDepositService } from './wallet.deposit.service';
import { OfflineFeeService } from '../offline-fee/offline-fee.service';
import { PlayerWorkStatus, StaffEmploymentStatus, WalletTxStatus } from '@prisma/client';
import { StaffRuleEngineService } from '../system-config/staff-rule-engine.service';
import { isDispatchMonitoredStaff } from '../common/utils/staff-role-scope.util';
import { WalletService } from './wallet.service';
import { EquipmentRentalFeeService } from '../equipment-rental-fee/equipment-rental-fee.service';

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
        private readonly walletService: WalletService,
        private readonly walletDepositService: WalletDepositService,
        private readonly offlineFeeService: OfflineFeeService,
        private readonly staffRuleEngineService: StaffRuleEngineService,
        private readonly equipmentRentalFeeService?: EquipmentRentalFeeService,
    ) {}

    private normalizeIdempotencyKey(idempotencyKey: string) {
        const key = String(idempotencyKey || '').trim();
        if (!key) {
            throw new BadRequestException('提现幂等键必填');
        }
        if (key.length > 64) {
            throw new BadRequestException('提现幂等键长度不能超过 64');
        }
        return key;
    }

    private async lockWalletAccountTx(tx: any, userId: number) {
        await tx.$queryRawUnsafe(
            'SELECT userId FROM wallet_accounts WHERE userId = ? FOR UPDATE',
            Number(userId),
        );
    }

    private async lockWithdrawalRequestTx(tx: any, requestId: number) {
        await tx.$queryRawUnsafe(
            'SELECT id FROM wallet_withdrawal_requests WHERE id = ? FOR UPDATE',
            Number(requestId),
        );
    }

    private assertWalletBucketsNonNegative(account: any) {
        const available = round2(Number(account?.availableBalance ?? 0));
        const frozen = round2(Number(account?.frozenBalance ?? 0));
        const withdrawFrozen = round2(Number(account?.withdrawFrozenBalance ?? 0));
        if (available < 0 || frozen < 0 || withdrawFrozen < 0) {
            throw new BadRequestException('钱包余额异常，资金操作已阻断');
        }
    }

    private assertWithdrawalFrozenBucketsNonNegative(account: any) {
        const frozen = round2(Number(account?.frozenBalance ?? 0));
        const withdrawFrozen = round2(Number(account?.withdrawFrozenBalance ?? 0));
        if (frozen < 0 || withdrawFrozen < 0) {
            throw new BadRequestException('钱包余额异常，资金操作已阻断');
        }
    }

    private async autoFreezeDormantStaffIfNeeded(userId: number, tx: any) {
        const user = await tx.user.findUnique({
            where: { id: Number(userId) },
            select: {
                id: true,
                userType: true,
                createdAt: true,
                staffEmploymentStatus: true,
                staffDormantFreezeBaseAt: true,
                staffTags: true,
                Role: {
                    select: {
                        name: true,
                    },
                },
            },
        });
        if (!user) return null;
        if (
            String(user?.staffEmploymentStatus || '') === StaffEmploymentStatus.FROZEN &&
            !isDispatchMonitoredStaff(user)
        ) {
            await tx.user.update({
                where: { id: Number(user.id) },
                data: {
                    staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
                    canWithdraw: true,
                },
            });
            return {
                ...user,
                staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
                canWithdraw: true,
            };
        }
        if (!isDispatchMonitoredStaff(user)) return user;
        if (String(user?.staffEmploymentStatus || StaffEmploymentStatus.ACTIVE) !== StaffEmploymentStatus.ACTIVE) return user;

        const lastAccepted = await tx.orderParticipant.findFirst({
            where: {
                userId: Number(user.id),
                acceptedAt: { not: null },
            },
            orderBy: { acceptedAt: 'desc' },
            select: { acceptedAt: true },
        });

        const lastAcceptedDate = lastAccepted?.acceptedAt ? new Date(lastAccepted.acceptedAt) : null;
        const manualBaseDate = user?.staffDormantFreezeBaseAt ? new Date(user.staffDormantFreezeBaseAt) : null;
        const createdAtDate = user?.createdAt ? new Date(user.createdAt) : null;
        const baseDate =
            (manualBaseDate && !Number.isNaN(manualBaseDate.getTime()) ? manualBaseDate : null) ||
            (lastAcceptedDate && !Number.isNaN(lastAcceptedDate.getTime()) ? lastAcceptedDate : null) ||
            (createdAtDate && !Number.isNaN(createdAtDate.getTime()) ? createdAtDate : null);
        if (!baseDate) return user;

        const staffRuleConfig = await this.staffRuleEngineService.getConfig();
        const dormantFreezeDays = this.staffRuleEngineService.getDormantFreezeDays(staffRuleConfig, user?.staffTags);
        const freezeAt = new Date(baseDate);
        freezeAt.setDate(freezeAt.getDate() + dormantFreezeDays);
        if (freezeAt.getTime() > Date.now()) return user;

        await tx.user.update({
            where: { id: Number(user.id) },
            data: {
                staffEmploymentStatus: StaffEmploymentStatus.FROZEN,
                canWithdraw: false,
                workStatus: PlayerWorkStatus.IDLE,
                workOnlineExpiresAt: null,
            },
        });

        return {
            ...user,
            staffEmploymentStatus: StaffEmploymentStatus.FROZEN,
        };
    }

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

    private buildReviewedAtRange(createdAtFrom?: string, createdAtTo?: string) {
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

        const reviewedAt: any = {};
        if (fromDate) reviewedAt.gte = fromDate;
        if (toDate) reviewedAt.lte = toDate;
        return { reviewedAt, fromDate, toDate };
    }

    private buildTodayReviewedAtRange() {
        const now = new Date();
        const fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        return {
            reviewedAt: {
                gte: fromDate,
                lte: toDate,
            },
            fromDate,
            toDate,
        };
    }

    private buildReviewedAtSingleDayRange(reviewDate?: string) {
        const formatLocalDate = (date: Date) => [
            date.getFullYear(),
            String(date.getMonth() + 1).padStart(2, '0'),
            String(date.getDate()).padStart(2, '0'),
        ].join('-');

        if (!reviewDate) {
            const range = this.buildTodayReviewedAtRange();
            return { ...range, reviewDate: formatLocalDate(range.fromDate) };
        }

        const text = String(reviewDate).trim();
        const matched = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!matched) {
            const range = this.buildTodayReviewedAtRange();
            return { ...range, reviewDate: formatLocalDate(range.fromDate) };
        }

        const year = Number(matched[1]);
        const month = Number(matched[2]);
        const day = Number(matched[3]);
        const fromDate = new Date(year, month - 1, day, 0, 0, 0, 0);
        const toDate = new Date(year, month - 1, day, 23, 59, 59, 999);

        return {
            reviewedAt: {
                gte: fromDate,
                lte: toDate,
            },
            fromDate,
            toDate,
            reviewDate: text,
        };
    }

    /**
     * ✅ 获取提现相关信息
     * 用于前端提现弹窗计算押金
     */
    async getWithdrawInfo(userId: number) {
        await this.prisma.$transaction(async (tx) => {
            await this.autoFreezeDormantStaffIfNeeded(userId, tx);
            await this.walletService.ensureWalletAccountBucketsReady(userId, tx as any, { throwOnDeficit: false });
        });

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                depositLimit: true,
                staffTags: true,
                staffEmploymentStatus: true,
                userType: true,
                Role: {
                    select: {
                        name: true,
                    },
                },
                walletAccount: {
                    select: {
                        availableBalance: true,
                        depositBalance: true,
                    },
                },
                workMode: true,
            },
        });

        if (!user) {
            throw new BadRequestException('用户不存在');
        }
        if (isDispatchMonitoredStaff(user) && String(user?.staffEmploymentStatus || '') === StaffEmploymentStatus.FROZEN) {
            const config = await this.staffRuleEngineService.getConfig();
            throw new ForbiddenException(
                this.staffRuleEngineService.buildDormantFreezeMessage(this.staffRuleEngineService.getDormantFreezeDays(config, user.staffTags)),
            );
        }

        const matchedRule = isDispatchMonitoredStaff(user)
            ? this.staffRuleEngineService.resolveMatchedRule(
                await this.staffRuleEngineService.getConfig(),
                user.staffTags,
            )
            : null;

        return {
            userType: user.userType,
            staffEmploymentStatus: user.staffEmploymentStatus,
            availableBalance: Number(user.walletAccount?.availableBalance || 0),
            depositBalance: Number(user.walletAccount?.depositBalance || 0),
            depositLimit: Number(matchedRule?.depositAmount ?? user.depositLimit ?? 500),
            firstWithdrawMinBalance: Number(matchedRule?.firstWithdrawMinBalance ?? 1000),
            firstWithdrawMinAcceptedDays: Number(matchedRule?.firstWithdrawMinAcceptedDays ?? 15),
            matchedStaffRule: matchedRule,
            workMode: user.workMode,
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
        payOfflineFeeAmount?: number;
    }) {
        const { userId, amount, remark, channel = 'MANUAL', payOfflineFeeAmount } = params;
        const idempotencyKey = this.normalizeIdempotencyKey(params.idempotencyKey);

        if (!amount || amount <= 0) {
            throw new BadRequestException('提现金额必须大于 0');
        }

        return this.prisma.$transaction(async (tx) => {
            const freezeCheckedUser = await this.autoFreezeDormantStaffIfNeeded(userId, tx);
            if (isDispatchMonitoredStaff(freezeCheckedUser) && String(freezeCheckedUser?.staffEmploymentStatus || '') === StaffEmploymentStatus.FROZEN) {
                const config = await this.staffRuleEngineService.getConfig();
                throw new ForbiddenException(
                    this.staffRuleEngineService.buildDormantFreezeMessage(this.staffRuleEngineService.getDormantFreezeDays(config, freezeCheckedUser?.staffTags)),
                );
            }

            // =========================
            // Step 0：读取用户信息
            // =========================
            const u = await tx.user.findUnique({
                where: { id: userId },
                select: {
                    withdrawQrCodeKey: true,
                    canWithdraw: true,
                    staffEmploymentStatus: true,
                    userType: true,
                    depositLimit: true,
                    staffTags: true,
                    workMode: true,
                },
            });

            if (!u) throw new BadRequestException('用户不存在');

            if (!u.withdrawQrCodeKey) {
                throw new BadRequestException('请先上传收款二维码');
            }

            const isStaff = u.userType === 'STAFF';
            const isActiveStaff =
                isStaff && String(u?.staffEmploymentStatus || StaffEmploymentStatus.ACTIVE) === StaffEmploymentStatus.ACTIVE;
            const allowExitedStaffWithdraw =
                isStaff && String(u?.staffEmploymentStatus || '') === StaffEmploymentStatus.EXITED;

            if (!u.canWithdraw && !allowExitedStaffWithdraw) {
                throw new BadRequestException('当前账户暂不允许提现');
            }

            await this.lockWalletAccountTx(tx, userId);

            const repeatedRequest = await tx.walletWithdrawalRequest.findFirst({
                where: { userId, idempotencyKey },
            });
            if (repeatedRequest) return repeatedRequest;

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

            if (historyCount === 0 && isActiveStaff) {
                const matchedRule = this.staffRuleEngineService.resolveMatchedRule(
                    await this.staffRuleEngineService.getConfig(),
                    u.staffTags,
                );
                const firstWithdrawMinBalance = Number(matchedRule?.firstWithdrawMinBalance ?? 1000);
                const firstWithdrawMinAcceptedDays = Number(matchedRule?.firstWithdrawMinAcceptedDays ?? 15);

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

                if (days < firstWithdrawMinAcceptedDays) {
                    throw new BadRequestException(`首次提现需接单满${firstWithdrawMinAcceptedDays}天`);
                }

                const accountCheck = await tx.walletAccount.findUnique({
                    where: { userId },
                    select: { availableBalance: true },
                });

                if (Number(accountCheck?.availableBalance || 0) < firstWithdrawMinBalance && isStaff) {
                    throw new BadRequestException(`首次提现余额需达到 ${firstWithdrawMinBalance}`);
                }
            }

            // =========================
            // Step 2：钱包校验
            // =========================
            const account = await tx.walletAccount.findUnique({
                where: { userId },
            });

            if (!account) throw new BadRequestException('钱包账户不存在');
            await this.walletService.ensureWalletAccountBucketsReady(userId, tx as any, {
                autoRepairOnDeficit: true,
                repairReason: '提现申请前自动修复钱包异常',
                operatorId: userId,
            });

            const refreshedAccount = await tx.walletAccount.findUnique({
                where: { userId },
            });

            const available = Number(refreshedAccount?.availableBalance || 0);

            if (available < amount) {
                throw new BadRequestException('可用余额不足');
            }

            if (available < 0) {
                throw new BadRequestException('账户存在欠款，请先补齐');
            }

            if (isActiveStaff && this.equipmentRentalFeeService) {
                const rentalObligation = await this.equipmentRentalFeeService.getWithdrawalObligationTx(tx as any, userId);
                const totalAfterWithdraw = round2(available + Number(refreshedAccount?.frozenBalance || 0) - amount);
                if (totalAfterWithdraw < Number(rentalObligation.totalObligation || 0)) {
                    throw new BadRequestException(
                        `提现后总资产不足以覆盖设备租赁费：已出账 ${rentalObligation.outstanding}，即将出账 ${rentalObligation.upcoming}`,
                    );
                }
            }

            let offlineFeePayment: {
                paidOfflineFeeAmount: number;
                billId: number | null;
                paymentId: number | null;
            } = {
                paidOfflineFeeAmount: 0,
                billId: null,
                paymentId: null,
            };

            if (u.workMode === 'OFFLINE') {
                offlineFeePayment = await this.offlineFeeService.validateAndCollectForWithdrawalTx({
                    tx: tx as any,
                    userId,
                    withdrawAmount: amount,
                    availableBalance: available,
                    frozenBalance: Number(refreshedAccount?.frozenBalance || 0),
                    payOfflineFeeAmount,
                });
            }

            // =========================
            // Step 3：计算押金
            // =========================
            let depositAdd = 0;

            if (isActiveStaff) {
                const matchedRule = this.staffRuleEngineService.resolveMatchedRule(
                    await this.staffRuleEngineService.getConfig(),
                    u.staffTags,
                );
                const depositLimit = Number(matchedRule?.depositAmount ?? u.depositLimit ?? 2000);
                const currentDeposit = Number(refreshedAccount?.depositBalance || 0);

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
            const accountAfterUpdate = await this.walletService.applyWalletAccountDelta(tx as any, userId, {
                availableDelta: -amount,
                depositDelta: depositAdd,
                withdrawFrozenDelta: withdrawAmount,
            });
            this.assertWalletBucketsNonNegative(accountAfterUpdate);

            // =========================
            // Step 5：押金流水
            // =========================
            if (depositAdd) {
                const depositTx = await tx.walletDepositTransaction.create({
                    data: {
                        userId,
                        amount: depositAdd,
                        bizType: 'WITHDRAW_PERCENT',
                        remark: '提现自动缴纳押金',
                    },
                });

                await tx.walletTransaction.create({
                    data: {
                        userId,
                        direction: 'OUT',
                        bizType: 'DEPOSIT_ADD',
                        amount: round2(depositAdd),
                        status: 'AVAILABLE',
                        sourceType: 'WALLET_DEPOSIT',
                        sourceId: depositTx.id,
                        availableAfter: round2(Number(accountAfterUpdate.availableBalance || 0)),
                        frozenAfter: round2(Number(accountAfterUpdate.frozenBalance || 0)),
                    },
                });
            }

            // =========================
            // Step 6：创建提现申请号
            // =========================
            const requestNo = this.genRequestNo();
            const reserveSourceType = `WITHDRAWAL_REQUEST_DRAFT:${requestNo}`;

            // =========================
            // Step 7：提现冻结流水
            // =========================
            const reserveTx = await tx.walletTransaction.create({
                data: {
                    userId,
                    direction: 'OUT',
                    bizType: 'WITHDRAW_RESERVE',
                    amount: withdrawAmount,
                    status: 'FROZEN',
                    sourceType: reserveSourceType,
                    sourceId: 0,
                    availableAfter: round2(Number(accountAfterUpdate.availableBalance || 0)),
                    frozenAfter: round2(Number(accountAfterUpdate.frozenBalance || 0)),
                },
            });

            // =========================
            // Step 8：创建提现申请
            // =========================

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

            await this.offlineFeeService.attachWithdrawalToPayment({
                tx: tx as any,
                paymentId: offlineFeePayment.paymentId,
                withdrawalRequestId: request.id,
            });

            await tx.walletTransaction.update({
                where: { id: reserveTx.id },
                data: { sourceId: request.id },
            });

            return {
                ...request,
                offlineFee: {
                    paidAmount: offlineFeePayment.paidOfflineFeeAmount,
                    billId: offlineFeePayment.billId,
                },
            };
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
            await this.lockWithdrawalRequestTx(tx, requestId);
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
                await this.lockWalletAccountTx(tx, req.userId);

                const existingPayout = await tx.walletTransaction.findUnique({
                    where: {
                        sourceType_sourceId: { sourceType: PAYOUT_SOURCE_TYPE, sourceId: req.id },
                    },
                    select: { id: true },
                });

                if (!existingPayout) {
                    await this.walletService.ensureWalletAccountBucketsReady(req.userId, tx as any, {
                        autoRepairOnDeficit: true,
                        repairReason: '提现审核通过前自动修复钱包异常',
                        operatorId: reviewerId,
                    });
                    // 2) 扣除冻结余额（真正扣款）
                    const accountAfterPayout = await this.walletService.applyWalletAccountDelta(tx as any, req.userId, {
                        withdrawFrozenDelta: -req.amount,
                    });
                    this.assertWalletBucketsNonNegative(accountAfterPayout);

                    // 3) 写出款流水（WITHDRAW_PAYOUT）
                    const payoutTx = await tx.walletTransaction.upsert({
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

                    return tx.walletWithdrawalRequest.update({
                        where: { id: requestId },
                        data: {
                            status: 'PAID',
                            reviewedBy: reviewerId,
                            reviewedAt: now,
                            reviewRemark,
                            payoutTxId: payoutTx.id,
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
                        payoutTxId: existingPayout.id,
                    },
                });
            }

            // ===========================
            // ❌ 审批驳回：资金退回（frozen -> available）+ 幂等退回流水
            // ===========================
            const RELEASE_SOURCE_TYPE = 'WITHDRAWAL_REQUEST_RELEASE';
            await this.lockWalletAccountTx(tx, req.userId);

            // 1) 先查“退回流水”是否已存在：存在则说明已退回过，避免重复回滚余额
            const existingReleaseTx = await tx.walletTransaction.findUnique({
                where: {
                    sourceType_sourceId: { sourceType: RELEASE_SOURCE_TYPE, sourceId: req.id },
                },
                select: { id: true },
            });

            if (!existingReleaseTx) {
                await this.walletService.ensureWalletAccountBucketsReady(req.userId, tx as any, {
                    autoRepairOnDeficit: true,
                    repairReason: '提现审核驳回前自动修复钱包异常',
                    operatorId: reviewerId,
                });
                // 2) 资金退回：frozen -amount, available +amount。
                // 可用余额允许仍为负，用于冲抵线下费用、罚单、设备租赁等扣款造成的欠款。
                const accountAfterRelease = await this.walletService.applyWalletAccountDelta(tx as any, req.userId, {
                    withdrawFrozenDelta: -req.amount,
                    availableDelta: req.amount,
                });
                this.assertWithdrawalFrozenBucketsNonNegative(accountAfterRelease);

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

    /**
     * 管理端：废除异常提现申请。
     * - 用于修复重新入驻、历史冲抵等场景下残留的待审/处理中提现单。
     * - 若预扣流水仍处于冻结且钱包提现冻结足够，则释放回可用余额；否则只修正申请单状态。
     */
    async cancelWithdrawal(params: {
        requestId: number;
        operatorId: number;
        remark?: string;
    }) {
        const { requestId, operatorId, remark } = params;
        const cancelRemark = String(remark || '').trim() || '管理员废除异常提现申请';

        return this.prisma.$transaction(async (tx) => {
            await this.lockWithdrawalRequestTx(tx, requestId);
            const req = await tx.walletWithdrawalRequest.findUnique({
                where: { id: Number(requestId) },
                include: { reserveTx: true },
            });
            if (!req) throw new BadRequestException('提现申请不存在');
            if (req.status === 'PAID') {
                throw new BadRequestException('已打款提现不能废除');
            }
            if (req.status === 'REJECTED' || req.status === 'CANCELED') return req;

            const now = new Date();
            await this.lockWalletAccountTx(tx, req.userId);
            await this.walletService.ensureWalletAccountBucketsReady(req.userId, tx as any, {
                autoRepairOnDeficit: true,
                repairReason: '提现申请废除前自动修复钱包异常',
                operatorId,
                throwOnDeficit: false,
            });

            const account = await tx.walletAccount.findUnique({ where: { userId: req.userId } });
            const canReleaseFrozen =
                String((req as any)?.reserveTx?.status || '') === String(WalletTxStatus.FROZEN) &&
                round2(Number(account?.withdrawFrozenBalance || 0)) >= round2(Number(req.amount || 0));

            if (canReleaseFrozen) {
                const accountAfterRelease = await this.walletService.applyWalletAccountDelta(tx as any, req.userId, {
                    withdrawFrozenDelta: -req.amount,
                    availableDelta: req.amount,
                });
                this.assertWithdrawalFrozenBucketsNonNegative(accountAfterRelease);

                await tx.walletTransaction.update({
                    where: { id: req.reserveTxId },
                    data: { status: WalletTxStatus.REVERSED as any },
                });

                await tx.walletTransaction.upsert({
                    where: {
                        sourceType_sourceId: { sourceType: 'WITHDRAWAL_REQUEST_CANCEL_RELEASE', sourceId: req.id },
                    },
                    create: {
                        userId: req.userId,
                        direction: 'IN',
                        bizType: 'WITHDRAW_RELEASE',
                        amount: req.amount,
                        status: 'AVAILABLE',
                        sourceType: 'WITHDRAWAL_REQUEST_CANCEL_RELEASE',
                        sourceId: req.id,
                        availableAfter: round2(Number((accountAfterRelease as any).availableBalance ?? 0)),
                        frozenAfter: round2(Number((accountAfterRelease as any).frozenBalance ?? 0)),
                        remark: cancelRemark,
                    },
                    update: {
                        direction: 'IN',
                        bizType: 'WITHDRAW_RELEASE',
                        amount: req.amount,
                        status: 'AVAILABLE',
                        availableAfter: round2(Number((accountAfterRelease as any).availableBalance ?? 0)),
                        frozenAfter: round2(Number((accountAfterRelease as any).frozenBalance ?? 0)),
                        remark: cancelRemark,
                    },
                });
            } else if (String((req as any)?.reserveTx?.status || '') === String(WalletTxStatus.FROZEN)) {
                await tx.walletTransaction.update({
                    where: { id: req.reserveTxId },
                    data: { status: WalletTxStatus.REVERSED as any },
                });
            }

            return tx.walletWithdrawalRequest.update({
                where: { id: req.id },
                data: {
                    status: 'CANCELED',
                    reviewedBy: operatorId || null,
                    reviewedAt: now,
                    reviewRemark: cancelRemark,
                    failReason: canReleaseFrozen ? null : '废除时未检测到足额提现冻结，仅修正申请单状态',
                },
            });
        });
    }

    /** 打手端：我的提现记录 */
    async listMine(userId: number) {
        const list = await this.prisma.walletWithdrawalRequest.findMany({
            where: { userId },
            orderBy: { id: 'desc' },
        });
        return list.map((row: any) => ({
            ...row,
            reviewTime: row.reviewedAt ?? null,
            statusText: this.getStatusText(row.status),
        }));
    }

    private getStatusText(status: string | null | undefined) {
        const map: Record<string, string> = {
            PENDING_REVIEW: '待审核',
            APPROVED: '已通过',
            REJECTED: '已驳回',
            PAYING: '打款中',
            PAID: '已打款',
            FAILED: '打款失败',
            CANCELED: '已废除',
        };
        return map[String(status || '')] || String(status || '-');
    }

    /** 管理端：待审核列表（带用户昵称 + 钱包余额 + 收款码临时URL） */
    async listPending(reviewDate?: string) {
        const where = { status: 'PENDING_REVIEW' as any };
        const { reviewedAt, fromDate, toDate, reviewDate: summaryDate } = this.buildReviewedAtSingleDayRange(reviewDate);

        const [count, aggregate, list, todayApprovedAgg, todayPaidAgg] = await this.prisma.$transaction([
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
            this.prisma.walletWithdrawalRequest.aggregate({
                where: {
                    reviewedAt,
                    status: { in: ['APPROVED', 'PAYING', 'PAID', 'FAILED'] as any },
                },
                _sum: { amount: true },
                _count: true,
            }),
            this.prisma.walletWithdrawalRequest.aggregate({
                where: {
                    reviewedAt,
                    status: 'PAID',
                },
                _sum: { amount: true },
                _count: true,
            }),
        ]);

        const enriched = await Promise.all(
            list.map(async (r: any) => {
                const wallet = await this.prisma.walletAccount.findUnique({
                    where: { userId: r.userId },
                    select: {
                        availableBalance: true,
                        frozenBalance: true,
                        earningFrozenBalance: true,
                        withdrawFrozenBalance: true,
                    },
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
                    wallet: wallet || {
                        availableBalance: 0,
                        frozenBalance: 0,
                        earningFrozenBalance: 0,
                        withdrawFrozenBalance: 0,
                    },
                    withdrawQrCodeUrl: withdrawQrCodeUrl || null,
                };
            }),
        );

        return {
            count,
            totalAmount: aggregate._sum.amount || 0,
            todayReviewSummary: {
                reviewDate: summaryDate,
                reviewedAtFrom: fromDate.toISOString(),
                reviewedAtTo: toDate.toISOString(),
                approvedAmount: Number(todayApprovedAgg?._sum?.amount || 0),
                approvedCount: Number(todayApprovedAgg?._count || 0),
                paidAmount: Number(todayPaidAgg?._sum?.amount || 0),
                paidCount: Number(todayPaidAgg?._count || 0),
            },
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

        const { reviewedAt } = this.buildReviewedAtRange(createdAtFrom, createdAtTo);
        where.reviewedAt = reviewedAt;

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
            list: (list as any[]).map((row: any) => ({
                ...row,
                reviewTime: row.reviewedAt ?? null,
            })),
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

    /**
     * ✅ 提现对账汇总（按审批时间范围）
     * 输出“谁提了多少”用于与线下转账流水做人工核对。
     */
    async reconcileSummary(params: {
        status?: string;
        channel?: string;
        userId?: number;
        requestNo?: string;
        createdAtFrom?: string;
        createdAtTo?: string;
    }) {
        const { status, channel, userId, requestNo, createdAtFrom, createdAtTo } = params || ({} as any);

        const baseWhere: any = {};
        if (status) baseWhere.status = status;
        if (channel) baseWhere.channel = channel;
        if (userId) baseWhere.userId = Number(userId);
        if (requestNo && String(requestNo).trim()) {
            baseWhere.requestNo = { contains: String(requestNo).trim() };
        }

        const { reviewedAt, fromDate, toDate } = this.buildReviewedAtRange(createdAtFrom, createdAtTo);
        baseWhere.reviewedAt = reviewedAt;

        const approvedStatusList = ['APPROVED', 'PAYING', 'PAID', 'FAILED'] as const;

        const rows = await this.prisma.walletWithdrawalRequest.findMany({
            where: {
                ...baseWhere,
                status: { in: [...approvedStatusList] as any },
            },
            select: {
                userId: true,
                amount: true,
                status: true,
            },
        });

        const approvedMap = new Map<number, { approvedAmount: number; approvedCount: number }>();
        const paidMap = new Map<number, { paidAmount: number; paidCount: number }>();
        for (const row of rows as any[]) {
            const uid = Number(row.userId);
            const amount = Number(row.amount || 0);
            const a = approvedMap.get(uid) || { approvedAmount: 0, approvedCount: 0 };
            a.approvedAmount += amount;
            a.approvedCount += 1;
            approvedMap.set(uid, a);

            if (String(row.status) === 'PAID') {
                const p = paidMap.get(uid) || { paidAmount: 0, paidCount: 0 };
                p.paidAmount += amount;
                p.paidCount += 1;
                paidMap.set(uid, p);
            }
        }

        const userIds = Array.from(new Set<number>([...approvedMap.keys(), ...paidMap.keys()]));

        const users = userIds.length
            ? await this.prisma.user.findMany({
                  where: { id: { in: userIds } },
                  select: { id: true, name: true, realName: true, phone: true },
              })
            : [];
        const userMap = new Map<number, any>(users.map((u) => [Number(u.id), u]));
        const byUser = Array.from(approvedMap.entries())
            .map(([uid, approved]) => {
                const userInfo = userMap.get(uid);
                const paid = paidMap.get(uid);
                const approvedAmount = Number(approved?.approvedAmount || 0);
                const paidAmount = Number(paid?.paidAmount || 0);
                return {
                    userId: uid,
                    name: userInfo?.name || null,
                    realName: userInfo?.realName || null,
                    phone: userInfo?.phone || null,
                    approvedAmount,
                    approvedCount: Number(approved?.approvedCount || 0),
                    paidAmount,
                    paidCount: Number(paid?.paidCount || 0),
                    transferGap: Number((approvedAmount - paidAmount).toFixed(2)),
                };
            })
            .sort((a, b) => b.approvedAmount - a.approvedAmount || b.approvedCount - a.approvedCount);

        const total = byUser.reduce(
            (acc, row) => {
                acc.approvedAmount += Number(row.approvedAmount || 0);
                acc.approvedCount += Number(row.approvedCount || 0);
                acc.paidAmount += Number(row.paidAmount || 0);
                acc.paidCount += Number(row.paidCount || 0);
                return acc;
            },
            { approvedAmount: 0, approvedCount: 0, paidAmount: 0, paidCount: 0 },
        );

        return {
            range: {
                reviewedAtFrom: fromDate ? fromDate.toISOString() : null,
                reviewedAtTo: toDate ? toDate.toISOString() : null,
            },
            total: {
                ...total,
                transferGap: Number((total.approvedAmount - total.paidAmount).toFixed(2)),
                userCount: byUser.length,
            },
            byUser,
        };
    }


}
