import { round2 as roundMoney } from '../utils/money/format';
import { getBookedBombLossByDispatch, getStaffExitOrderReserve, staffExitOrderReserveReason, unsettledStaffOrderStatuses } from './staff-exit-order-reserve';
import {BadRequestException, ForbiddenException, Injectable} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {tcbGetTempFileURL} from "../common/cloudbase.storage";
import { WalletDepositService } from './wallet.deposit.service';
import { OfflineFeeService } from '../offline-fee/offline-fee.service';
import { PlayerWorkStatus, StaffEmploymentStatus, WalletTxStatus, WithdrawalTransferStatus } from '@prisma/client';
import { StaffRuleEngineService } from '../system-config/staff-rule-engine.service';
import { isDispatchMonitoredStaff } from '../common/utils/staff-role-scope.util';
import { WalletService } from './wallet.service';
import { EquipmentRentalFeeService } from '../equipment-rental-fee/equipment-rental-fee.service';
import { inspectWalletFundingTx } from './wallet-funding.util';
import { SystemConfigService } from '../system-config/system-config.service';
import { WechatWithdrawalTransferService } from './wechat-withdrawal-transfer.service';

export const WITHDRAW_DEPOSIT_AUTO_FILL_RATE = 0.2;

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
        private readonly systemConfigService: SystemConfigService,
        private readonly wechatTransferService: WechatWithdrawalTransferService,
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
        // 长期未接单自动冻结已停用。
        return tx.user.findUnique({ where: { id: Number(userId) } });
        /* istanbul ignore next */
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

    private genTransferOutTradeNo(req: { id: number; requestNo?: string | null }) {
        const base = String(req?.requestNo || `WD${req.id}`).replace(/[^A-Za-z0-9_-]/g, '');
        return `WDT${base}`.slice(0, 64);
    }

    private async getExitWithdrawalEligibilityTx(tx: any, userId: number, user?: any) {
        const current = user ?? await tx.user.findUnique({
            where: { id: userId },
            select: { staffEmploymentStatus: true, canWithdraw: true, staffExitedAt: true },
        });
        const status = current?.staffEmploymentStatus;
        if (status === StaffEmploymentStatus.BLACKLISTED) {
            return { reserve: null, blockReason: '已加入黑名单的服务者不可提现' };
        }
        if (status !== StaffEmploymentStatus.EXITED) return { reserve: null, blockReason: null };

        if (current.canWithdraw === false && current.staffExitedAt) {
            const clear = await tx.userLog.findFirst({
                where: { targetType: 'USER', targetId: userId, action: 'STAFF_CLEAR', createdAt: { gte: current.staffExitedAt } },
                select: { id: true },
            });
            if (clear) return { reserve: null, blockReason: '已清退账户不可提现' };
        }
        return { reserve: await getStaffExitOrderReserve(tx, userId), blockReason: null };
    }

    private async assertExitOrderReserveTx(tx: any, userId: number, remainingAssets: number, user?: any) {
        const { reserve, blockReason } = await this.getExitWithdrawalEligibilityTx(tx, userId, user);
        const reason = blockReason ?? (reserve && staffExitOrderReserveReason(reserve, remainingAssets));
        if (reason) throw new BadRequestException(reason);
    }

    private async quoteReservedPayout(tx: any, req: any, spendableAssets: number, user?: any) {
        if (req.status !== 'PENDING_REVIEW' || req.channel !== 'MANUAL' || req.outTradeNo ||
            req.transferStatus !== 'NOT_STARTED' || req.payoutTxId) return null;
        const { reserve, blockReason } = await this.getExitWithdrawalEligibilityTx(tx, req.userId, user);
        if (!reserve || blockReason || reserve.needsReview) return null;
        const remaining = Number(req.amount);
        if (Number(req.partialPaidAmount ?? 0) === 0) {
            const hold = roundMoney(reserve.amount - spendableAssets);
            if (spendableAssets < 0 || !reserve.amount || hold <= 0 || hold >= remaining) return null;
            const otherPartial = await tx.walletWithdrawalRequest.findFirst({
                where: { userId: req.userId, status: 'PENDING_REVIEW', partialPaidAmount: { gt: 0 } },
                select: { id: true },
            });
            if (otherPartial) return null;
            return { stage: 'PARTIAL' as const, payout: roundMoney(remaining - hold), hold, offset: 0, orders: reserve.items };
        }
        if (reserve.items.length || !Array.isArray(req.reserveDispatchIds)) return null;
        const saved: { dispatchId: number; bookedAmount: number }[] = req.reserveDispatchIds;
        const dispatchIds = saved.map(({ dispatchId }) => dispatchId);
        const unsettled = await tx.orderDispatch.count({
            where: { id: { in: dispatchIds }, order: { status: { in: unsettledStaffOrderStatuses } } },
        });
        if (unsettled) return null;
        const booked = await getBookedBombLossByDispatch(tx, req.userId, dispatchIds);
        const confirmedLoss = roundMoney(saved.reduce((total, row) =>
            total + Math.max(0, (booked.get(row.dispatchId) ?? 0) - row.bookedAmount), 0));
        const offset = roundMoney(Math.max(0, -spendableAssets));
        if (offset > remaining || offset > confirmedLoss) return null;
        return { stage: 'FINAL' as const, payout: roundMoney(remaining - offset), hold: 0, offset, orders: [] };
    }

    async recordReservedPayout(params: {
        requestId: number; operatorId: number; stage: 'PARTIAL' | 'FINAL';
        payout: number; offset: number; remark: string;
    }) {
        const { requestId, operatorId, stage, payout, offset } = params;
        const remark = typeof params.remark === 'string' ? params.remark.trim() : '';
        if (!remark || remark.length > 500 || !['PARTIAL', 'FINAL'].includes(stage) ||
            !Number.isFinite(payout) || !Number.isFinite(offset)) {
            throw new BadRequestException('请确认出款金额并填写服务者确认和打款凭证备注');
        }
        return this.prisma.$transaction(async (tx) => {
            await this.lockWithdrawalRequestTx(tx, requestId);
            const req = await tx.walletWithdrawalRequest.findUnique({ where: { id: requestId } });
            if (!req) throw new BadRequestException('提现申请不存在');
            const sourceType = stage === 'PARTIAL' ? 'WITHDRAWAL_PARTIAL_PAYOUT' : 'WITHDRAWAL_REQUEST_PAYOUT';
            const existing = await tx.walletTransaction.findUnique({
                where: { sourceType_sourceId: { sourceType, sourceId: req.id } },
                select: { amount: true },
            });
            if (stage === 'PARTIAL' && existing && roundMoney(existing.amount) === payout && offset === 0) return req;
            if (stage === 'FINAL' && req.status === 'PAID' && Number(req.partialPaidAmount) > 0 &&
                roundMoney(req.amount - Number(req.partialPaidAmount)) === payout && Number(req.reserveOffsetAmount) === offset) return req;

            await this.lockWalletAccountTx(tx, req.userId);
            const funding = await inspectWalletFundingTx(tx, req.userId, req.id);
            const quote = await this.quoteReservedPayout(tx, req, funding.spendableAssets);
            if (!quote || quote.stage !== stage || quote.payout !== payout || quote.offset !== offset) {
                throw new BadRequestException('预留或出款金额已变化，请刷新并核对，避免重复打款');
            }

            const account = await this.walletService.applyWalletAccountDelta(tx, req.userId, {
                withdrawFrozenDelta: stage === 'PARTIAL' ? -payout : -req.amount,
                availableDelta: offset,
            });
            this.assertWithdrawalFrozenBucketsNonNegative(account);
            const snapshot = { availableAfter: Number(account.availableBalance), frozenAfter: Number(account.frozenBalance) };
            const payoutTx = payout > 0 ? await tx.walletTransaction.create({ data: {
                userId: req.userId, direction: 'OUT', bizType: 'WITHDRAW_PAYOUT', status: 'AVAILABLE',
                amount: payout, sourceType, sourceId: req.id, remark, ...snapshot,
            } }) : null;
            if (offset > 0) {
                await tx.walletTransaction.create({ data: {
                    userId: req.userId, direction: 'IN', bizType: 'WITHDRAW_RELEASE', status: 'AVAILABLE',
                    amount: offset, sourceType: 'WITHDRAWAL_BOMB_RESERVE_RELEASE', sourceId: req.id,
                    remark: '释放预留资金抵扣已入账的存单炸补欠款', ...snapshot,
                } });
            }
            await tx.walletTransaction.update({ where: { id: req.reserveTxId }, data: stage === 'PARTIAL'
                ? { amount: quote.hold, ...snapshot } : { status: 'AVAILABLE', ...snapshot } });
            const now = new Date();
            return tx.walletWithdrawalRequest.update({ where: { id: req.id }, data: stage === 'PARTIAL'
                ? {
                    amount: quote.hold, partialPaidAmount: payout,
                    reserveDispatchIds: quote.orders.map(({ dispatchId, bookedAmount }) => ({ dispatchId, bookedAmount })),
                    reviewedBy: operatorId, reviewedAt: now, transferStartedAt: now, reviewRemark: remark,
                }
                : {
                    amount: roundMoney(Number(req.partialPaidAmount) + payout), reserveOffsetAmount: offset,
                    status: 'PAID', transferStatus: 'SUCCESS', transferFinishedAt: now, payoutTxId: payoutTx?.id,
                    reviewRemark: [req.reviewRemark, remark].filter(Boolean).join('；'),
                },
            });
        }, { isolationLevel: 'ReadCommitted' });
    }

    private async completeWithdrawalPayoutTx(tx: any, req: any, operatorId: number, patch: any = {}) {
        if (Number(req.partialPaidAmount) > 0) throw new BadRequestException('请通过预留余款流程完成出款');
        const PAYOUT_SOURCE_TYPE = 'WITHDRAWAL_REQUEST_PAYOUT';
        await this.lockWalletAccountTx(tx, req.userId);

        const existingPayout = await tx.walletTransaction.findUnique({
            where: {
                sourceType_sourceId: { sourceType: PAYOUT_SOURCE_TYPE, sourceId: req.id },
            },
            select: { id: true },
        });

        if (existingPayout) {
            return tx.walletWithdrawalRequest.update({
                where: { id: req.id },
                data: {
                    status: 'PAID',
                    transferStatus: WithdrawalTransferStatus.SUCCESS,
                    transferFinishedAt: patch.transferFinishedAt || new Date(),
                    payoutTxId: existingPayout.id,
                    ...patch,
                },
            });
        }

        await this.walletService.ensureWalletAccountBucketsReady(req.userId, tx as any, {
            autoRepairOnDeficit: true,
            repairReason: '提现出款完成前自动修复钱包异常',
            operatorId,
        });

        const funding = await inspectWalletFundingTx(tx, req.userId, req.id);
        if (funding.spendableAssets < 0) {
            throw new BadRequestException('有效收益冻结不足以覆盖可用余额欠款，暂不能出款，可驳回释放提现冻结');
        }
        // 微信成功回执只登记已发生的出款。预留检查在向微信发起打款前执行。
        if (patch.channel !== 'WECHAT') {
            await this.assertExitOrderReserveTx(tx, req.userId, funding.spendableAssets);
        }
        const accountAfterPayout = await this.walletService.applyWalletAccountDelta(tx as any, req.userId, {
            withdrawFrozenDelta: -req.amount,
        });
        this.assertWithdrawalFrozenBucketsNonNegative(accountAfterPayout);

        const payoutTx = await tx.walletTransaction.upsert({
            where: {
                sourceType_sourceId: { sourceType: PAYOUT_SOURCE_TYPE, sourceId: req.id },
            },
            create: {
                userId: req.userId,
                direction: 'OUT',
                bizType: 'WITHDRAW_PAYOUT',
                amount: req.amount,
                status: 'AVAILABLE',
                sourceType: PAYOUT_SOURCE_TYPE,
                sourceId: req.id,
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
            where: { id: req.id },
            data: {
                status: 'PAID',
                transferStatus: WithdrawalTransferStatus.SUCCESS,
                transferFinishedAt: patch.transferFinishedAt || new Date(),
                payoutTxId: payoutTx.id,
                ...patch,
            },
        });
    }

    private async assertWechatAutoTransferAllowed(req: any) {
        const autoEnabled = await this.systemConfigService.getBoolean(SystemConfigService.KEYS.WITHDRAW_AUTO_TRANSFER_ENABLED, false);
        const wechatEnabled = await this.systemConfigService.getBoolean(SystemConfigService.KEYS.WITHDRAW_WECHAT_TRANSFER_ENABLED, false);
        if (!autoEnabled || !wechatEnabled) {
            throw new BadRequestException('微信自动打款未开启，请使用人工扫码兜底');
        }

        const eligibility = await this.systemConfigService.getJson<any>(SystemConfigService.KEYS.WITHDRAW_AUTO_ELIGIBILITY, {
            mode: 'WHITELIST',
            userIds: [],
            staffRuleGroups: [],
            allowActiveStaffOnly: true,
            requireWechatBinding: true,
        });
        const user = await this.prisma.user.findUnique({
            where: { id: Number(req.userId) },
            select: {
                id: true,
                userType: true,
                staffEmploymentStatus: true,
                staffTags: true,
                realName: true,
            },
        });
        if (!user) throw new BadRequestException('服务者不存在');
        if (eligibility?.allowActiveStaffOnly !== false) {
            const isActiveStaff =
                String(user.userType || '') === 'STAFF' &&
                String(user.staffEmploymentStatus || '') === StaffEmploymentStatus.ACTIVE;
            if (!isActiveStaff) throw new BadRequestException('仅正常在店服务者可使用微信自动打款');
        }

        const mode = String(eligibility?.mode || 'WHITELIST').toUpperCase();
        const allowAll = mode === 'ALL';
        const allowedUserIds = new Set((Array.isArray(eligibility?.userIds) ? eligibility.userIds : []).map((item: any) => Number(item)).filter((item: number) => item > 0));
        const allowedGroups = new Set((Array.isArray(eligibility?.staffRuleGroups) ? eligibility.staffRuleGroups : []).map((item: any) => String(item || '').trim()).filter(Boolean));
        const userGroups = Array.isArray(user.staffTags) ? user.staffTags.map((item: any) => String(item || '').trim()).filter(Boolean) : [];
        const hitUser = allowedUserIds.has(Number(user.id));
        const hitGroup = userGroups.some((item) => allowedGroups.has(item));
        if (!allowAll && !hitUser && !hitGroup) {
            throw new BadRequestException('该服务者未开通小额微信自动打款资格，请使用人工扫码兜底');
        }

        if (eligibility?.requireWechatBinding !== false) {
            await this.wechatTransferService.getReceiverOpenid(req.userId);
        }

        const amount = round2(Number(req?.amount || 0));
        const singleLimit = await this.systemConfigService.getNumber(SystemConfigService.KEYS.WITHDRAW_AUTO_SINGLE_LIMIT, 2000);
        if (amount > Number(singleLimit || 2000)) {
            throw new BadRequestException(`单笔超过自动打款上限 ${singleLimit}，请转人工处理`);
        }

        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        const [userDay, userMonth, platformDay, paidHistoryCount] = await this.prisma.$transaction([
            this.prisma.walletWithdrawalRequest.aggregate({
                where: { userId: req.userId, channel: 'WECHAT', status: 'PAID', transferFinishedAt: { gte: startOfDay, lte: endOfDay } },
                _sum: { amount: true },
            }),
            this.prisma.walletWithdrawalRequest.aggregate({
                where: { userId: req.userId, channel: 'WECHAT', status: 'PAID', transferFinishedAt: { gte: startOfMonth, lte: endOfMonth } },
                _sum: { amount: true },
            }),
            this.prisma.walletWithdrawalRequest.aggregate({
                where: { channel: 'WECHAT', status: 'PAID', transferFinishedAt: { gte: startOfDay, lte: endOfDay } },
                _sum: { amount: true },
            }),
            this.prisma.walletWithdrawalRequest.count({
                where: { userId: req.userId, status: 'PAID' },
            }),
        ]);

        const userDayLimit = await this.systemConfigService.getNumber(SystemConfigService.KEYS.WITHDRAW_AUTO_USER_DAY_LIMIT, 5000);
        const userMonthLimit = await this.systemConfigService.getNumber(SystemConfigService.KEYS.WITHDRAW_AUTO_USER_MONTH_LIMIT, 15000);
        const platformDayLimit = await this.systemConfigService.getNumber(SystemConfigService.KEYS.WITHDRAW_AUTO_PLATFORM_DAY_LIMIT, 50000);
        const firstLimit = await this.systemConfigService.getNumber(SystemConfigService.KEYS.WITHDRAW_AUTO_FIRST_LIMIT, 1000);

        if (paidHistoryCount === 0 && amount > Number(firstLimit || 1000)) {
            throw new BadRequestException(`新人首次自动打款上限 ${firstLimit}，请转人工处理`);
        }
        if (Number(userDay?._sum?.amount || 0) + amount > Number(userDayLimit || 5000)) {
            throw new BadRequestException(`单人每日自动打款超过 ${userDayLimit}，请转人工处理`);
        }
        if (Number(userMonth?._sum?.amount || 0) + amount > Number(userMonthLimit || 15000)) {
            throw new BadRequestException(`单人每月自动打款超过 ${userMonthLimit}，请转人工处理`);
        }
        if (Number(platformDay?._sum?.amount || 0) + amount > Number(platformDayLimit || 50000)) {
            throw new BadRequestException(`平台每日自动打款超过 ${platformDayLimit}，请转人工处理`);
        }

        const status = await this.wechatTransferService.getConfigStatus();
        if (!status.ready) {
            throw new BadRequestException('微信商家转账配置未就绪，请使用人工扫码兜底');
        }
    }

    private async getWechatAutoEligibilitySnapshot(userId: number) {
        const autoEnabled = await this.systemConfigService.getBoolean(SystemConfigService.KEYS.WITHDRAW_AUTO_TRANSFER_ENABLED, false);
        const wechatEnabled = await this.systemConfigService.getBoolean(SystemConfigService.KEYS.WITHDRAW_WECHAT_TRANSFER_ENABLED, false);
        const eligibility = await this.systemConfigService.getJson<any>(SystemConfigService.KEYS.WITHDRAW_AUTO_ELIGIBILITY, {
            mode: 'WHITELIST',
            userIds: [],
            staffRuleGroups: [],
            allowActiveStaffOnly: true,
            requireWechatBinding: true,
        });
        const user = await this.prisma.user.findUnique({
            where: { id: Number(userId) },
            select: {
                id: true,
                userType: true,
                staffEmploymentStatus: true,
                staffTags: true,
            },
        });
        const allowedUserIds = new Set((Array.isArray(eligibility?.userIds) ? eligibility.userIds : []).map((item: any) => Number(item)).filter((item: number) => item > 0));
        const allowedGroups = new Set((Array.isArray(eligibility?.staffRuleGroups) ? eligibility.staffRuleGroups : []).map((item: any) => String(item || '').trim()).filter(Boolean));
        const userGroups = Array.isArray(user?.staffTags) ? user.staffTags.map((item: any) => String(item || '').trim()).filter(Boolean) : [];
        const mode = String(eligibility?.mode || 'WHITELIST').toUpperCase();
        const hitEligibility = mode === 'ALL' || allowedUserIds.has(Number(user?.id || 0)) || userGroups.some((item) => allowedGroups.has(item));
        const isActiveStaff =
            String(user?.userType || '') === 'STAFF' &&
            String(user?.staffEmploymentStatus || '') === StaffEmploymentStatus.ACTIVE;

        let bound = false;
        let bindMessage = '';
        try {
            await this.wechatTransferService.getReceiverOpenid(userId);
            bound = true;
        } catch (e: any) {
            bindMessage = e?.message || '未绑定微信';
        }

        const reasons: string[] = [];
        if (!autoEnabled) reasons.push('自动打款总开关未开启');
        if (!wechatEnabled) reasons.push('微信自动打款通道未开启');
        if (eligibility?.allowActiveStaffOnly !== false && !isActiveStaff) reasons.push('仅正常在店服务者可用');
        if (!hitEligibility) reasons.push('未在小额自动打款白名单或规则分组内');
        if (eligibility?.requireWechatBinding !== false && !bound) reasons.push(bindMessage || '未绑定微信');

        return {
            autoEnabled,
            wechatEnabled,
            eligibilityMode: mode,
            eligible: reasons.length === 0,
            reasons,
            wechatBinding: {
                bound,
                message: bound ? '已绑定当前小程序微信' : bindMessage,
            },
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
                staffExitedAt: true,
                canWithdraw: true,
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

        const eligibility = await this.getExitWithdrawalEligibilityTx(this.prisma, userId, user);
        const reserve = eligibility.reserve;
        const availableBalance = Number(user.walletAccount?.availableBalance || 0);
        return {
            userType: user.userType,
            staffEmploymentStatus: user.staffEmploymentStatus,
            availableBalance: eligibility.blockReason || reserve?.needsReview ? 0
                : reserve ? Math.max(0, roundMoney(availableBalance - reserve.amount)) : availableBalance,
            staffExitOrderReserve: reserve?.amount ?? 0,
            staffExitOrderReserveNeedsReview: reserve?.needsReview ?? false,
            depositBalance: Number(user.walletAccount?.depositBalance || 0),
            depositLimit: Number(matchedRule?.depositAmount ?? user.depositLimit ?? 500),
            firstWithdrawMinBalance: Number(matchedRule?.firstWithdrawMinBalance ?? 1000),
            firstWithdrawMinAcceptedOrders: Number(matchedRule?.firstWithdrawMinAcceptedOrders ?? 20),
            matchedStaffRule: matchedRule,
            workMode: user.workMode,
            wechatAutoTransfer: await this.getWechatAutoEligibilitySnapshot(userId),
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
        const { userId, amount, remark } = params;
        const channel = 'MANUAL';
        const idempotencyKey = this.normalizeIdempotencyKey(params.idempotencyKey);

        if (!amount || amount <= 0) {
            throw new BadRequestException('提现金额必须大于 0');
        }

        const reviewed = await this.prisma.$transaction(async (tx) => {
            await this.lockWalletAccountTx(tx, userId);
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
                    staffExitedAt: true,
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
                const firstWithdrawMinAcceptedOrders = Number(matchedRule?.firstWithdrawMinAcceptedOrders ?? 20);

                // 按订单去重；历史轮次接过单也计入，不受当前参与者 isActive 影响。
                const acceptedOrderCount = await tx.order.count({
                    where: {
                        status: { notIn: ['CANCELLED', 'REFUNDED'] },
                        dispatches: {
                            some: {
                                participants: {
                                    some: { userId, acceptedAt: { not: null }, rejectedAt: null },
                                },
                            },
                        },
                    },
                });

                if (acceptedOrderCount < firstWithdrawMinAcceptedOrders) {
                    throw new BadRequestException(`首次提现需接单满${firstWithdrawMinAcceptedOrders}单，当前已接${acceptedOrderCount}单`);
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

            await this.assertExitOrderReserveTx(tx, userId, available - amount, u);

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

            if (isActiveStaff) {
                const offlineFeeObligation = await this.offlineFeeService.getWithdrawalObligationTx(tx as any, userId);
                if (Number(offlineFeeObligation.outstanding || 0) > 0) {
                    throw new BadRequestException(
                        `存在临近到期的线下费用账单未结清，需先缴清 ${offlineFeeObligation.outstanding} 后再申请提现`,
                    );
                }
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

                    const depositByRate = Math.floor(amount * WITHDRAW_DEPOSIT_AUTO_FILL_RATE);

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

            await tx.walletTransaction.update({
                where: { id: reserveTx.id },
                data: { sourceId: request.id },
            });

            return {
                ...request,
            };
        }, { isolationLevel: 'ReadCommitted' });

        return reviewed;
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
        channel?: 'MANUAL' | 'WECHAT';
        autoTransfer?: boolean;
    }) {
        const { requestId, reviewerId, approve, reviewRemark } = params;

        const reviewed = await this.prisma.$transaction(async (tx) => {
            await this.lockWithdrawalRequestTx(tx, requestId);
            const req = await tx.walletWithdrawalRequest.findUnique({
                where: { id: requestId },
            });
            if (!req) throw new BadRequestException('提现申请不存在');

            // ✅ 幂等：终态直接返回，避免重复扣减/重复流水
            if (req.status === 'PAID' || req.status === 'REJECTED') return req;

            if (Number(req.partialPaidAmount) > 0) throw new BadRequestException('该申请已部分出款，请通过预留余款流程处理');
            if (approve && req.status !== 'PENDING_REVIEW') {
                throw new BadRequestException('该提现申请不在待审核状态');
            }
            if (!approve && !['PENDING_REVIEW', 'APPROVED', 'FAILED'].includes(String(req.status))) {
                throw new BadRequestException('该提现申请当前状态不能驳回');
            }

            const now = new Date();

            // ===========================
            // ✅ 审批通过：当前阶段按“通过即出款完成”处理（最小改动）
            // ===========================
            if (approve) {
                return this.completeWithdrawalPayoutTx(tx, req, reviewerId, {
                    channel: 'MANUAL',
                    reviewedBy: reviewerId,
                    reviewedAt: now,
                    reviewRemark,
                    transferStatus: WithdrawalTransferStatus.SUCCESS,
                    transferStartedAt: now,
                    transferFinishedAt: now,
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
                    transferStatus: WithdrawalTransferStatus.CANCELLED,
                    transferFinishedAt: now,
                    reviewedBy: reviewerId,
                    reviewedAt: now,
                    reviewRemark,
                },
            });
        // 等待钱包行锁期间可能发生租号扣款；用当前已提交余额，不能沿用等待前的快照。
        }, { isolationLevel: 'ReadCommitted' });

        if (reviewed?.status === 'PAYING' && reviewed?.channel === 'WECHAT') {
            return this.startWechatTransfer(Number(reviewed.id), Number(reviewerId));
        }

        return reviewed;
    }

    async startWechatTransfer(requestId: number, operatorId: number) {
        const req = await this.prisma.walletWithdrawalRequest.findUnique({ where: { id: Number(requestId) } });
        if (!req) throw new BadRequestException('提现申请不存在');
        if (req.status === 'PAID') return req;
        if (!['PAYING', 'FAILED'].includes(String(req.status))) {
            throw new BadRequestException('当前提现申请状态不允许发起微信自动打款');
        }
        if (String(req.channel) !== 'WECHAT') {
            throw new BadRequestException('当前提现申请不是微信自动打款通道');
        }
        await this.assertWechatAutoTransferAllowed(req);

        const outTradeNo = await this.prisma.$transaction(async (tx) => {
            await this.lockWithdrawalRequestTx(tx, requestId);
            const latest = await tx.walletWithdrawalRequest.findUnique({ where: { id: requestId } });
            if (!latest || !['PAYING', 'FAILED'].includes(latest.status) || latest.channel !== 'WECHAT') {
                throw new BadRequestException('该提现申请已变更，请刷新后重试');
            }
            await this.lockWalletAccountTx(tx, latest.userId);
            const funding = await inspectWalletFundingTx(tx, latest.userId, latest.id);
            await this.assertExitOrderReserveTx(tx, latest.userId, funding.spendableAssets);
            const billNo = latest.outTradeNo || this.genTransferOutTradeNo(latest);
            await tx.walletWithdrawalRequest.update({
                where: { id: latest.id },
                data: {
                    status: 'PAYING',
                    transferStatus: WithdrawalTransferStatus.PROCESSING,
                    outTradeNo: billNo,
                    transferStartedAt: latest.transferStartedAt || new Date(),
                    failReason: null,
                },
            });
            return billNo;
        }, { isolationLevel: 'ReadCommitted' });

        try {
            const result = await this.wechatTransferService.createTransfer({
                userId: req.userId,
                requestNo: req.requestNo,
                outBillNo: outTradeNo,
                amountFen: Math.max(1, Math.round(Number(req.amount || 0) * 100)),
                remark: `提现${req.requestNo}`,
            });
            return this.applyTransferResult(req.id, operatorId, result);
        } catch (e: any) {
            const msg = e?.response?.data?.message || e?.data?.message || e?.message || '微信提现发起失败';
            return this.prisma.walletWithdrawalRequest.update({
                where: { id: req.id },
                data: {
                    status: 'FAILED',
                    transferStatus: WithdrawalTransferStatus.FAILED,
                    failReason: String(msg),
                    transferFinishedAt: new Date(),
                },
            });
        }
    }

    private async applyTransferResult(requestId: number, operatorId: number, result: any) {
        const status = String(result?.status || '').toUpperCase();
        const now = new Date();
        const callbackRaw = JSON.stringify(result?.raw || result || {});
        const channelTradeNo = String(result?.transferBillNo || '').trim() || undefined;

        if (status === 'SUCCESS') {
            return this.prisma.$transaction(async (tx) => {
                await this.lockWithdrawalRequestTx(tx, requestId);
                const req = await tx.walletWithdrawalRequest.findUnique({ where: { id: requestId } });
                if (!req) throw new BadRequestException('提现申请不存在');
                if (req.status === 'PAID') return req;
                return this.completeWithdrawalPayoutTx(tx, req, operatorId, {
                    channel: 'WECHAT',
                    transferStatus: WithdrawalTransferStatus.SUCCESS,
                    channelTradeNo,
                    callbackRaw,
                    failReason: null,
                    transferFinishedAt: now,
                });
            }, { isolationLevel: 'ReadCommitted' });
        }

        if (status === 'FAILED' || status === 'CANCELLED' || status === 'CANCELED') {
            return this.prisma.walletWithdrawalRequest.update({
                where: { id: requestId },
                data: {
                    status: 'FAILED',
                    transferStatus: status === 'FAILED' ? WithdrawalTransferStatus.FAILED : WithdrawalTransferStatus.CANCELLED,
                    channelTradeNo,
                    callbackRaw,
                    failReason: result?.raw?.fail_reason || result?.raw?.message || '微信提现失败或已撤销',
                    transferFinishedAt: now,
                },
            });
        }

        return this.prisma.walletWithdrawalRequest.update({
            where: { id: requestId },
            data: {
                status: 'PAYING',
                transferStatus: status === 'WAIT_USER_CONFIRM'
                    ? WithdrawalTransferStatus.WAIT_USER_CONFIRM
                    : WithdrawalTransferStatus.PROCESSING,
                channelTradeNo,
                callbackRaw,
            },
        });
    }

    async queryWechatTransfer(requestId: number, operatorId: number) {
        const req = await this.prisma.walletWithdrawalRequest.findUnique({ where: { id: Number(requestId) } });
        if (!req) throw new BadRequestException('提现申请不存在');
        if (String(req.channel) !== 'WECHAT') throw new BadRequestException('当前提现申请不是微信自动打款通道');
        const outTradeNo = String(req.outTradeNo || '').trim();
        if (!outTradeNo) throw new BadRequestException('缺少微信提现平台出款单号');
        const result = await this.wechatTransferService.queryTransfer(outTradeNo);
        return this.applyTransferResult(req.id, operatorId, result);
    }

    async fallbackToManual(params: { requestId: number; operatorId: number; remark?: string }) {
        const { requestId, operatorId, remark } = params;
        return this.prisma.$transaction(async (tx) => {
            await this.lockWithdrawalRequestTx(tx, requestId);
            const req = await tx.walletWithdrawalRequest.findUnique({ where: { id: Number(requestId) } });
            if (!req) throw new BadRequestException('提现申请不存在');
            if (req.status === 'PAID') return req;
            if (!['PAYING', 'FAILED', 'APPROVED'].includes(String(req.status))) {
                throw new BadRequestException('当前提现申请状态不允许转人工');
            }
            return tx.walletWithdrawalRequest.update({
                where: { id: req.id },
                data: {
                    status: 'APPROVED',
                    channel: 'MANUAL',
                    transferStatus: WithdrawalTransferStatus.MANUAL_FALLBACK,
                    manualFallbackAt: new Date(),
                    manualFallbackBy: operatorId || null,
                    reviewRemark: [req.reviewRemark, String(remark || '转人工扫码处理').trim()].filter(Boolean).join('；'),
                },
            });
        });
    }

    async completeManualPayout(params: { requestId: number; operatorId: number; remark?: string }) {
        const { requestId, operatorId, remark } = params;
        return this.prisma.$transaction(async (tx) => {
            await this.lockWithdrawalRequestTx(tx, requestId);
            const req = await tx.walletWithdrawalRequest.findUnique({ where: { id: Number(requestId) } });
            if (!req) throw new BadRequestException('提现申请不存在');
            if (req.status === 'PAID') return req;
            if (String(req.channel) !== 'MANUAL') throw new BadRequestException('当前提现申请不是人工扫码通道');
            if (!['APPROVED', 'FAILED'].includes(String(req.status))) {
                throw new BadRequestException('当前提现申请状态不允许确认人工打款');
            }
            const now = new Date();
            return this.completeWithdrawalPayoutTx(tx, req, operatorId, {
                channel: 'MANUAL',
                reviewedBy: req.reviewedBy || operatorId,
                reviewedAt: req.reviewedAt || now,
                reviewRemark: [req.reviewRemark, String(remark || '人工扫码已打款').trim()].filter(Boolean).join('；'),
                transferStatus: req.transferStatus === WithdrawalTransferStatus.MANUAL_FALLBACK
                    ? WithdrawalTransferStatus.MANUAL_FALLBACK
                    : WithdrawalTransferStatus.SUCCESS,
                transferFinishedAt: now,
            });
        }, { isolationLevel: 'ReadCommitted' });
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
            if (Number(req.partialPaidAmount) > 0) throw new BadRequestException('已部分出款的申请须通过预留余款流程结清');
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
                    transferStatus: WithdrawalTransferStatus.CANCELLED,
                    transferFinishedAt: now,
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
            statusText: row.status === 'PENDING_REVIEW' && Number(row.partialPaidAmount) > 0
                ? '已部分出款，余款预留' : this.getStatusText(row.status),
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
        const where = { status: { in: ['PENDING_REVIEW', 'PAYING', 'FAILED', 'APPROVED'] as any } };
        const { reviewedAt, fromDate, toDate, reviewDate: summaryDate } = this.buildReviewedAtSingleDayRange(reviewDate);

        const [count, aggregate, list, todayApprovedAgg, todayPaidAgg, todayPartialAgg] = await this.prisma.$transaction([
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
                            staffEmploymentStatus: true,
                            canWithdraw: true,
                            staffExitedAt: true,
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
            this.prisma.walletWithdrawalRequest.aggregate({
                where: { reviewedAt, status: 'PENDING_REVIEW', partialPaidAmount: { gt: 0 } },
                _sum: { partialPaidAmount: true }, _count: true,
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

                let reservedPayout: Awaited<ReturnType<WalletWithdrawalsService['quoteReservedPayout']>> = null;
                let reviewEligibility: { canApprove: boolean; reason: string; postWithdrawalTotalBalance: number };
                try {
                    const funding = await inspectWalletFundingTx(this.prisma as any, r.userId, r.id);
                    reservedPayout = await this.quoteReservedPayout(this.prisma, r, funding.spendableAssets, r.user);
                    if (Number(r.partialPaidAmount) > 0) throw new BadRequestException('已部分出款，余款须通过预留流程结清');
                    await this.assertExitOrderReserveTx(this.prisma, r.userId, funding.spendableAssets, r.user);
                    reviewEligibility = funding.spendableAssets >= 0
                        ? { canApprove: true, reason: '可放行', postWithdrawalTotalBalance: funding.spendableAssets }
                        : { canApprove: false, reason: '提现后有效资产不足以覆盖欠款', postWithdrawalTotalBalance: funding.spendableAssets };
                } catch (error: any) {
                    reviewEligibility = {
                        canApprove: false,
                        reason: String(error?.message || '资金校验未通过'),
                        postWithdrawalTotalBalance:
                            Number(wallet?.availableBalance || 0) + Number(wallet?.earningFrozenBalance || 0),
                    };
                }

                let withdrawQrCodeUrl: string | null = null;
                const cloudObjectId = r?.user?.withdrawQrCodeKey;
                if ((reviewEligibility.canApprove || (reservedPayout && reservedPayout.payout > 0)) && cloudObjectId) {
                    withdrawQrCodeUrl = await tcbGetTempFileURL({
                        cloudPath: cloudObjectId,
                        maxAgeSeconds: 600,
                    });
                }

                const [equipmentRisk, offlineFeeRisk] = await Promise.all([
                    this.equipmentRentalFeeService
                        ? this.equipmentRentalFeeService.getWithdrawalRiskPreviewTx(this.prisma as any, r.userId)
                        : Promise.resolve({ outstandingAmount: 0, estimatedAmount: 0, totalRiskAmount: 0, contractCount: 0 }),
                    this.offlineFeeService.getWithdrawalRiskPreviewTx(this.prisma as any, r.userId),
                ]);
                const feeRiskTotal = round2(
                    Number(equipmentRisk.totalRiskAmount || 0) +
                    Number(offlineFeeRisk.totalRiskAmount || 0),
                );
                const fundingAfterWithdrawal = round2(Number(reviewEligibility.postWithdrawalTotalBalance || 0));
                const riskGapAmount = round2(Math.max(0, feeRiskTotal - Math.max(0, fundingAfterWithdrawal)));
                const feeRiskPreview = {
                    riskLevel: riskGapAmount > 0 ? 'HIGH' : feeRiskTotal > 0 ? 'NOTICE' : 'NONE',
                    totalRiskAmount: feeRiskTotal,
                    riskGapAmount,
                    fundingAfterWithdrawal,
                    equipment: equipmentRisk,
                    offlineManagement: offlineFeeRisk,
                };

                return {
                    ...r,
                    wallet: wallet || {
                        availableBalance: 0,
                        frozenBalance: 0,
                        earningFrozenBalance: 0,
                        withdrawFrozenBalance: 0,
                    },
                    withdrawQrCodeUrl: withdrawQrCodeUrl || null,
                    reservedPayout,
                    reviewEligibility,
                    feeRiskPreview,
                    wechatAutoTransfer: await this.getWechatAutoEligibilitySnapshot(r.userId),
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
                approvedAmount: roundMoney(Number(todayApprovedAgg?._sum?.amount || 0) + Number(todayPartialAgg._sum.partialPaidAmount || 0)),
                approvedCount: Number(todayApprovedAgg?._count || 0) + todayPartialAgg._count,
                paidAmount: roundMoney(Number(todayPaidAgg?._sum?.amount || 0) + Number(todayPartialAgg._sum.partialPaidAmount || 0)),
                paidCount: Number(todayPaidAgg?._count || 0) + todayPartialAgg._count,
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
        transferStatus?: string;
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
            transferStatus,
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
        if (transferStatus) where.transferStatus = transferStatus;
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

        const [total, list, approvedAgg, paidAgg, partialAgg] = await this.prisma.$transaction([
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
            this.prisma.walletWithdrawalRequest.aggregate({
                where: { AND: [where, { status: 'PENDING_REVIEW', partialPaidAmount: { gt: 0 } }] },
                _sum: { partialPaidAmount: true }, _count: true,
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
                approvedAmount: roundMoney(Number(approvedAgg._sum.amount || 0) + Number(partialAgg._sum.partialPaidAmount || 0)),
                approvedCount: approvedAgg._count + partialAgg._count,
                paidAmount: roundMoney(Number(paidAgg._sum.amount || 0) + Number(partialAgg._sum.partialPaidAmount || 0)),
                paidCount: paidAgg._count + partialAgg._count,
            },
        };
    }

    /**
     * ✅ 提现对账汇总（按审批时间范围）
     * 输出“谁提了多少”用于与线下转账流水做人工核对。
     */
    async reconcileSummary(params: {
        status?: string;
        transferStatus?: string;
        channel?: string;
        userId?: number;
        requestNo?: string;
        createdAtFrom?: string;
        createdAtTo?: string;
    }) {
        const { status, transferStatus, channel, userId, requestNo, createdAtFrom, createdAtTo } = params || ({} as any);

        const baseWhere: any = {};
        if (status) baseWhere.status = status;
        if (transferStatus) baseWhere.transferStatus = transferStatus;
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
                AND: [baseWhere, { OR: [
                    { status: { in: [...approvedStatusList] } },
                    { status: 'PENDING_REVIEW', partialPaidAmount: { gt: 0 } },
                ] }],
            },
            select: {
                userId: true,
                amount: true,
                status: true,
                partialPaidAmount: true,
            },
        });

        const approvedMap = new Map<number, { approvedAmount: number; approvedCount: number }>();
        const paidMap = new Map<number, { paidAmount: number; paidCount: number }>();
        for (const row of rows as any[]) {
            const uid = Number(row.userId);
            const partial = row.status === 'PENDING_REVIEW';
            const amount = Number(partial ? row.partialPaidAmount : row.amount);
            const a = approvedMap.get(uid) || { approvedAmount: 0, approvedCount: 0 };
            a.approvedAmount += amount;
            a.approvedCount += 1;
            approvedMap.set(uid, a);

            if (row.status === 'PAID' || partial) {
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
