import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {
    BillingMode,
    DispatchStatus,
    Prisma,
    PrismaClient,
    WalletBizType,
    WalletDirection,
    WalletHoldStatus,
    WalletTxStatus,
} from '@prisma/client';
import {QueryWalletHoldsDto} from "./dto/query-wallet-holds.dto";
import {QueryWalletTransactionsDto} from "./dto/query-wallet-transactions.dto";
import {roundMix1, toNum} from "../utils/money/format";
import { tcbGetTempFileURL, tcbUploadFile } from '../common/cloudbase.storage';
import {
    buildWalletAccountDeltaData,
    buildWalletAccountSetData,
    normalizeWalletAccountBuckets,
    round2Amount,
    walletAccountBalanceSelect,
} from './wallet-account-buckets.util';

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

    private getActiveWithdrawalStatuses() {
        return ['PENDING_REVIEW', 'APPROVED', 'PAYING', 'FAILED'] as const;
    }

    private buildWalletRepairRemark(input: {
        currentAvailable: number;
        currentFrozen: number;
        currentTotal: number;
        targetAvailable: number;
        targetFrozen: number;
        targetTotal: number;
        reason?: string;
    }) {
        const parts = [
            '修复冻结流水统计错误',
            `修复前冻结 ${round2Amount(input.currentFrozen)}`,
            `可用 ${round2Amount(input.currentAvailable)}`,
            `总余额 ${round2Amount(input.currentTotal)}`,
            `修复后冻结 ${round2Amount(input.targetFrozen)}`,
            `可用 ${round2Amount(input.targetAvailable)}`,
            `总余额 ${round2Amount(input.targetTotal)}`,
        ];
        if (input.reason) {
            parts.push(`原因：${String(input.reason).trim()}`);
        }
        return parts.join('；');
    }

    private buildWalletAnomalySignature(input: {
        currentAvailable: number;
        currentFrozen: number;
        currentTotal: number;
        replayAvailable: number;
        replayFrozen: number;
        replayTotal: number;
        availableGap: number;
        frozenGap: number;
        totalGap: number;
    }) {
        return [
            round2Amount(input.currentAvailable),
            round2Amount(input.currentFrozen),
            round2Amount(input.currentTotal),
            round2Amount(input.replayAvailable),
            round2Amount(input.replayFrozen),
            round2Amount(input.replayTotal),
            round2Amount(input.availableGap),
            round2Amount(input.frozenGap),
            round2Amount(input.totalGap),
        ].join('|');
    }

    private parseWalletRepairSource(sourceType: string | null | undefined) {
        const text = String(sourceType || '').trim();
        const availablePrefix = 'WALLET_ANOMALY_REPAIR_AVAILABLE:';
        const frozenPrefix = 'WALLET_ANOMALY_REPAIR_FROZEN:';
        const rollbackAvailablePrefix = 'WALLET_ANOMALY_REPAIR_ROLLBACK_AVAILABLE:';
        const rollbackFrozenPrefix = 'WALLET_ANOMALY_REPAIR_ROLLBACK_FROZEN:';

        if (text.startsWith(availablePrefix)) {
            return { kind: 'AVAILABLE' as const, token: text.slice(availablePrefix.length), rollback: false };
        }
        if (text.startsWith(frozenPrefix)) {
            return { kind: 'FROZEN' as const, token: text.slice(frozenPrefix.length), rollback: false };
        }
        if (text.startsWith(rollbackAvailablePrefix)) {
            return { kind: 'AVAILABLE' as const, token: text.slice(rollbackAvailablePrefix.length), rollback: true };
        }
        if (text.startsWith(rollbackFrozenPrefix)) {
            return { kind: 'FROZEN' as const, token: text.slice(rollbackFrozenPrefix.length), rollback: true };
        }
        return null;
    }

    private buildWalletRepairRollbackRemark(input: {
        currentAvailable: number;
        currentFrozen: number;
        currentTotal: number;
        targetAvailable: number;
        targetFrozen: number;
        targetTotal: number;
        sourceToken: string;
        reason?: string;
    }) {
        const parts = [
            '回滚异常修复流水',
            `修复标记 ${input.sourceToken}`,
            `回滚前冻结 ${round2Amount(input.currentFrozen)}`,
            `可用 ${round2Amount(input.currentAvailable)}`,
            `总余额 ${round2Amount(input.currentTotal)}`,
            `回滚后冻结 ${round2Amount(input.targetFrozen)}`,
            `可用 ${round2Amount(input.targetAvailable)}`,
            `总余额 ${round2Amount(input.targetTotal)}`,
        ];
        if (input.reason) {
            parts.push(`原因：${String(input.reason).trim()}`);
        }
        return parts.join('；');
    }

    private async buildWalletRepairPreviewItem(audit: any, options?: { reason?: string }) {
        const replay = await this.previewReplayByUser({
            userId: Number(audit.userId),
            mode: 'full',
            limitMismatches: 200,
        });

        const currentAvailable = round2Amount(audit.currentAvailable);
        const currentFrozen = round2Amount(audit.currentFrozen);
        const currentTotal = round2Amount(audit.currentTotal);

        const replayAvailable = round2Amount(replay?.replayBalance?.available);
        const replayFrozen = round2Amount(replay?.replayBalance?.frozen);
        const replayTotal = round2Amount(replay?.replayBalance?.total);
        const replayEarningFrozen = round2Amount(replay?.replayBuckets?.earningFrozen);
        const replayWithdrawFrozen = round2Amount(replay?.replayBuckets?.withdrawFrozen);

        const totalGap = round2Amount(replayTotal - currentTotal);
        const totalUnchanged = Math.abs(totalGap) <= 0.009;
        const totalDecrease = totalGap < -0.009;
        const canApplyByReplay = totalUnchanged || totalDecrease;

        const targetAvailable = canApplyByReplay ? replayAvailable : currentAvailable;
        const targetFrozen = canApplyByReplay ? replayFrozen : currentFrozen;
        const targetTotal = canApplyByReplay ? replayTotal : currentTotal;
        const targetEarningFrozen = canApplyByReplay ? replayEarningFrozen : round2Amount(audit.currentEarningFrozen);
        const targetWithdrawFrozen = canApplyByReplay ? replayWithdrawFrozen : round2Amount(audit.currentWithdrawFrozen);

        const availableDelta = round2Amount(targetAvailable - currentAvailable);
        const frozenDelta = round2Amount(targetFrozen - currentFrozen);
        const totalDelta = round2Amount(targetTotal - currentTotal);
        const remark = this.buildWalletRepairRemark({
            currentAvailable,
            currentFrozen,
            currentTotal,
            targetAvailable,
            targetFrozen,
            targetTotal,
            reason: options?.reason,
        });

        return {
            ...audit,
            replayBalance: {
                available: round2Amount(replay?.replayBalance?.available),
                frozen: replayFrozen,
                total: replayTotal,
            },
            repairPreview: {
                currentAvailable,
                currentFrozen,
                currentTotal,
                targetAvailable,
                targetFrozen,
                targetTotal,
                targetEarningFrozen,
                targetWithdrawFrozen,
                availableDelta,
                frozenDelta,
                totalDelta,
                totalGap,
                totalUnchanged,
                totalDecrease,
                canApplyByReplay,
                reason: options?.reason || '',
                remark,
            },
        };
    }

    private async applyWalletRepairPlan(params: {
        userId: number;
        reason?: string;
        operatorId?: number;
        tx?: PrismaTx;
    }) {
        const runner = async (tx: PrismaTx) => {
            const audit = await this.inspectWalletAccountState(params.userId, tx as any);
            const preview = await this.buildWalletRepairPreviewItem(audit, { reason: params.reason });
            const repair = preview.repairPreview;

            if (!repair.canApplyByReplay) {
                throw new BadRequestException(`重放修复已阻断：本次修复将上调账户总余额 ${round2Amount(repair.totalGap)}，存在资金风险，需人工核对。`);
            }

            let accountAfter = await this.getWalletAccountBalance(params.userId, tx as any);
            const createdTxs: any[] = [];
            const sourceToken = `U${params.userId}:${Date.now()}:${Math.floor(Math.random() * 1000)}`;

            if (Math.abs(repair.availableDelta) > 0.009) {
                accountAfter = await this.applyWalletAccountDelta(tx as any, params.userId, {
                    availableDelta: repair.availableDelta,
                });

                const txRow = await (tx as any).walletTransaction.create({
                    data: {
                        userId: params.userId,
                        direction: repair.availableDelta >= 0 ? WalletDirection.IN : WalletDirection.OUT,
                        bizType: WalletBizType.SETTLEMENT_RECALC,
                        amount: round2(Math.abs(repair.availableDelta)),
                        status: WalletTxStatus.AVAILABLE,
                        sourceType: `WALLET_ANOMALY_REPAIR_AVAILABLE:${sourceToken}`,
                        sourceId: 0,
                        availableAfter: round2(Number((accountAfter as any)?.availableBalance ?? 0)),
                        frozenAfter: round2(Number((accountAfter as any)?.frozenBalance ?? 0)),
                        remark: repair.remark,
                    } as any,
                });
                createdTxs.push(txRow);
            }

            const earningFrozenDelta = round2Amount(repair.targetEarningFrozen - Number((accountAfter as any)?.earningFrozenBalance ?? 0));
            const withdrawFrozenDelta = round2Amount(repair.targetWithdrawFrozen - Number((accountAfter as any)?.withdrawFrozenBalance ?? 0));
            const frozenDelta = round2Amount(earningFrozenDelta + withdrawFrozenDelta);

            if (Math.abs(earningFrozenDelta) > 0.009 || Math.abs(withdrawFrozenDelta) > 0.009) {
                accountAfter = await this.applyWalletAccountDelta(tx as any, params.userId, {
                    earningFrozenDelta,
                    withdrawFrozenDelta,
                });

                if (Math.abs(frozenDelta) > 0.009) {
                    const txRow = await (tx as any).walletTransaction.create({
                        data: {
                            userId: params.userId,
                            direction: frozenDelta >= 0 ? WalletDirection.IN : WalletDirection.OUT,
                            bizType: WalletBizType.SETTLEMENT_RECALC,
                            amount: round2(Math.abs(frozenDelta)),
                            status: WalletTxStatus.FROZEN,
                            sourceType: `WALLET_ANOMALY_REPAIR_FROZEN:${sourceToken}`,
                            sourceId: 0,
                            availableAfter: round2(Number((accountAfter as any)?.availableBalance ?? 0)),
                            frozenAfter: round2(Number((accountAfter as any)?.frozenBalance ?? 0)),
                            remark: repair.remark,
                        } as any,
                    });
                    createdTxs.push(txRow);
                }
            }

            const finalAccount = await (tx as any).walletAccount.update({
                where: { userId: params.userId },
                data: buildWalletAccountSetData({
                    availableBalance: repair.targetAvailable,
                    earningFrozenBalance: repair.targetEarningFrozen,
                    withdrawFrozenBalance: repair.targetWithdrawFrozen,
                    depositBalance: Number(preview.depositBalance || 0),
                }),
                select: walletAccountBalanceSelect,
            });

            return {
                ...preview,
                applied: true,
                operatorId: params.operatorId || null,
                transactions: createdTxs.map((row: any) => ({
                    id: row.id,
                    direction: row.direction,
                    bizType: row.bizType,
                    amount: row.amount,
                    status: row.status,
                    remark: row.remark ?? repair.remark,
                })),
                account: normalizeWalletAccountBuckets(finalAccount),
            };
        };

        if (params.tx) {
            return runner(params.tx);
        }
        return this.prisma.$transaction(async (tx) => runner(tx as any));
    }

    private async collectWalletRepairRollbackCandidates(params?: {
        userId?: number;
        limit?: number;
        onlyBalanceIncrease?: boolean;
    }) {
        const userId = Number(params?.userId || 0);
        const limit = Math.min(1000, Math.max(1, Number(params?.limit || 200)));
        const onlyBalanceIncrease = params?.onlyBalanceIncrease !== false;

        const repairRows: any[] = await this.prisma.walletTransaction.findMany({
            where: {
                ...(userId ? { userId } : {}),
                OR: [
                    { sourceType: { startsWith: 'WALLET_ANOMALY_REPAIR_AVAILABLE:' } },
                    { sourceType: { startsWith: 'WALLET_ANOMALY_REPAIR_FROZEN:' } },
                ],
            } as any,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: userId ? undefined : limit * 4,
            select: {
                id: true,
                userId: true,
                amount: true,
                direction: true,
                status: true,
                sourceType: true,
                sourceId: true,
                createdAt: true,
                remark: true,
            } as any,
        });

        const rollbackRows: any[] = await this.prisma.walletTransaction.findMany({
            where: {
                ...(userId ? { userId } : {}),
                OR: [
                    { sourceType: { startsWith: 'WALLET_ANOMALY_REPAIR_ROLLBACK_AVAILABLE:' } },
                    { sourceType: { startsWith: 'WALLET_ANOMALY_REPAIR_ROLLBACK_FROZEN:' } },
                ],
            } as any,
            select: {
                userId: true,
                sourceType: true,
            },
        });

        const rolledBackKeys = new Set<string>();
        for (const row of rollbackRows) {
            const parsed = this.parseWalletRepairSource(row.sourceType);
            if (!parsed?.rollback || !parsed.token) continue;
            rolledBackKeys.add(`${Number(row.userId)}:${parsed.token}`);
        }

        const groups = new Map<string, any>();
        for (const row of repairRows) {
            const parsed = this.parseWalletRepairSource(row.sourceType);
            if (!parsed || parsed.rollback || !parsed.token) continue;

            const key = `${Number(row.userId)}:${parsed.token}`;
            const signedAmount = String(row.direction) === 'OUT' ? -round2Amount(row.amount) : round2Amount(row.amount);

            if (!groups.has(key)) {
                groups.set(key, {
                    userId: Number(row.userId),
                    sourceToken: parsed.token,
                    createdAt: row.createdAt,
                    lastCreatedAt: row.createdAt,
                    repairTxIds: [],
                    availableDelta: 0,
                    frozenDelta: 0,
                    totalDelta: 0,
                    originalRemark: row.remark || '',
                });
            }

            const group = groups.get(key);
            group.repairTxIds.push(Number(row.id));
            group.lastCreatedAt = row.createdAt;
            if (!group.originalRemark && row.remark) {
                group.originalRemark = row.remark;
            }
            if (parsed.kind === 'AVAILABLE') {
                group.availableDelta = round2Amount(group.availableDelta + signedAmount);
            } else {
                group.frozenDelta = round2Amount(group.frozenDelta + signedAmount);
            }
            group.totalDelta = round2Amount(group.availableDelta + group.frozenDelta);
        }

        const candidates = Array.from(groups.values())
            .filter((item) => !rolledBackKeys.has(`${item.userId}:${item.sourceToken}`))
            .filter((item) => Math.abs(Number(item.totalDelta || 0)) > 0.009)
            .filter((item) => (onlyBalanceIncrease ? Number(item.totalDelta || 0) > 0.009 : true))
            .sort((a, b) => {
                const at = new Date(a.createdAt).getTime();
                const bt = new Date(b.createdAt).getTime();
                if (at !== bt) return at - bt;
                return Number(a.userId) - Number(b.userId);
            });

        return candidates.slice(0, userId ? candidates.length : limit);
    }

    private async buildWalletRepairRollbackPreviewItem(group: any, options?: { reason?: string }) {
        const audit = await this.inspectWalletAccountState(Number(group.userId), this.prisma as any);

        const currentAvailable = round2Amount(audit.currentAvailable);
        const currentFrozen = round2Amount(audit.currentFrozen);
        const currentTotal = round2Amount(audit.currentTotal);
        const targetTotal = round2Amount(currentTotal - Number(group.totalDelta || 0));
        const targetEarningFrozen = round2Amount(audit.expectedEarningFrozen);
        const targetWithdrawFrozen = round2Amount(audit.expectedWithdrawFrozen);
        const targetFrozen = round2Amount(targetEarningFrozen + targetWithdrawFrozen);
        const targetAvailable = round2Amount(targetTotal - targetFrozen);
        const availableDelta = round2Amount(targetAvailable - currentAvailable);
        const frozenDelta = round2Amount(targetFrozen - currentFrozen);
        const canApply = targetTotal >= -0.009;
        const blockedReason = canApply
            ? ''
            : `回滚后总余额将变为 ${round2Amount(targetTotal)}，已阻断自动回滚，请人工核对。`;
        const remark = this.buildWalletRepairRollbackRemark({
            currentAvailable,
            currentFrozen,
            currentTotal,
            targetAvailable,
            targetFrozen,
            targetTotal,
            sourceToken: String(group.sourceToken || ''),
            reason: options?.reason,
        });

        return {
            ...group,
            currentAvailable,
            currentFrozen,
            currentTotal,
            targetAvailable,
            targetFrozen,
            targetTotal,
            targetEarningFrozen,
            targetWithdrawFrozen,
            availableDelta,
            frozenDelta,
            totalDelta: round2Amount(targetTotal - currentTotal),
            repairTotalDelta: round2Amount(group.totalDelta),
            canApply,
            blockedReason,
            reason: options?.reason || '',
            remark,
            audit,
        };
    }

    private async applyWalletRepairRollbackPlan(params: {
        preview: any;
        reason?: string;
        operatorId?: number;
        tx?: PrismaTx;
    }) {
        const runner = async (tx: PrismaTx) => {
            const preview = await this.buildWalletRepairRollbackPreviewItem(params.preview, { reason: params.reason });
            if (!preview.canApply) {
                throw new BadRequestException(preview.blockedReason || '当前回滚已被阻断');
            }

            let accountAfter = await this.getWalletAccountBalance(Number(preview.userId), tx as any);
            const createdTxs: any[] = [];

            if (Math.abs(preview.availableDelta) > 0.009) {
                accountAfter = await this.applyWalletAccountDelta(tx as any, Number(preview.userId), {
                    availableDelta: preview.availableDelta,
                });

                const txRow = await (tx as any).walletTransaction.create({
                    data: {
                        userId: Number(preview.userId),
                        direction: preview.availableDelta >= 0 ? WalletDirection.IN : WalletDirection.OUT,
                        bizType: WalletBizType.SETTLEMENT_RECALC,
                        amount: round2(Math.abs(preview.availableDelta)),
                        status: WalletTxStatus.AVAILABLE,
                        sourceType: `WALLET_ANOMALY_REPAIR_ROLLBACK_AVAILABLE:${preview.sourceToken}`,
                        sourceId: Number(preview.userId),
                        availableAfter: round2(Number((accountAfter as any)?.availableBalance ?? 0)),
                        frozenAfter: round2(Number((accountAfter as any)?.frozenBalance ?? 0)),
                        remark: preview.remark,
                    } as any,
                });
                createdTxs.push(txRow);
            }

            const earningFrozenDelta = round2Amount(preview.targetEarningFrozen - Number((accountAfter as any)?.earningFrozenBalance ?? 0));
            const withdrawFrozenDelta = round2Amount(preview.targetWithdrawFrozen - Number((accountAfter as any)?.withdrawFrozenBalance ?? 0));
            const frozenDelta = round2Amount(earningFrozenDelta + withdrawFrozenDelta);

            if (Math.abs(earningFrozenDelta) > 0.009 || Math.abs(withdrawFrozenDelta) > 0.009) {
                accountAfter = await this.applyWalletAccountDelta(tx as any, Number(preview.userId), {
                    earningFrozenDelta,
                    withdrawFrozenDelta,
                });

                if (Math.abs(frozenDelta) > 0.009) {
                    const txRow = await (tx as any).walletTransaction.create({
                        data: {
                            userId: Number(preview.userId),
                            direction: frozenDelta >= 0 ? WalletDirection.IN : WalletDirection.OUT,
                            bizType: WalletBizType.SETTLEMENT_RECALC,
                            amount: round2(Math.abs(frozenDelta)),
                            status: WalletTxStatus.FROZEN,
                            sourceType: `WALLET_ANOMALY_REPAIR_ROLLBACK_FROZEN:${preview.sourceToken}`,
                            sourceId: Number(preview.userId),
                            availableAfter: round2(Number((accountAfter as any)?.availableBalance ?? 0)),
                            frozenAfter: round2(Number((accountAfter as any)?.frozenBalance ?? 0)),
                            remark: preview.remark,
                        } as any,
                    });
                    createdTxs.push(txRow);
                }
            }

            const finalAccount = await (tx as any).walletAccount.update({
                where: { userId: Number(preview.userId) },
                data: buildWalletAccountSetData({
                    availableBalance: preview.targetAvailable,
                    earningFrozenBalance: preview.targetEarningFrozen,
                    withdrawFrozenBalance: preview.targetWithdrawFrozen,
                    depositBalance: Number(preview.audit?.depositBalance || 0),
                }),
                select: walletAccountBalanceSelect,
            });

            return {
                ...preview,
                applied: true,
                operatorId: params.operatorId || null,
                transactions: createdTxs.map((row: any) => ({
                    id: row.id,
                    direction: row.direction,
                    bizType: row.bizType,
                    amount: row.amount,
                    status: row.status,
                    remark: row.remark ?? preview.remark,
                })),
                account: normalizeWalletAccountBuckets(finalAccount),
            };
        };

        if (params.tx) {
            return runner(params.tx);
        }
        return this.prisma.$transaction(async (tx) => runner(tx as any));
    }

    async getWalletAccountBalance(userId: number, tx?: PrismaTx) {
        const db = (tx as any) ?? this.prisma;
        return db.walletAccount.findUnique({
            where: { userId },
            select: walletAccountBalanceSelect,
        });
    }

    async applyWalletAccountDelta(
        tx: PrismaTx,
        userId: number,
        input: {
            availableDelta?: number;
            earningFrozenDelta?: number;
            withdrawFrozenDelta?: number;
            depositDelta?: number;
        },
    ) {
        await this.ensureWalletAccount(userId, tx);
        const data = buildWalletAccountDeltaData(input);
        if (!Object.keys(data).length) {
            return this.getWalletAccountBalance(userId, tx);
        }
        return (tx as any).walletAccount.update({
            where: { userId },
            data,
            select: walletAccountBalanceSelect,
        });
    }

    private async inspectWalletAccountState(userId: number, tx?: PrismaTx) {
        const db = (tx as any) ?? this.prisma;
        await this.ensureWalletAccount(userId, db);

        const [account, holdAgg, withdrawAgg, negativeAgg, pendingCount, user] = await Promise.all([
            this.getWalletAccountBalance(userId, db),
            db.walletHold.aggregate({
                where: { userId, status: WalletHoldStatus.FROZEN },
                _sum: { amount: true },
                _count: true,
            }),
            db.walletWithdrawalRequest.aggregate({
                where: {
                    userId,
                    status: { in: [...this.getActiveWithdrawalStatuses()] as any },
                },
                _sum: { amount: true },
                _count: true,
            }),
            db.walletTransaction.aggregate({
                where: { userId, frozenAfter: { lt: 0 } as any },
                _count: true,
                _min: { frozenAfter: true, createdAt: true },
                _max: { createdAt: true },
            }),
            db.walletWithdrawalRequest.count({
                where: {
                    userId,
                    status: { in: [...this.getActiveWithdrawalStatuses()] as any },
                },
            }),
            db.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    phone: true,
                    name: true,
                    userType: true,
                    status: true,
                    canWithdraw: true,
                },
            }),
        ]);

        const normalized = normalizeWalletAccountBuckets(account);
        const expectedEarningFrozen = round2Amount(holdAgg?._sum?.amount);
        const expectedWithdrawFrozen = round2Amount(withdrawAgg?._sum?.amount);
        const expectedFrozen = round2Amount(expectedEarningFrozen + expectedWithdrawFrozen);
        const expectedAvailable = round2Amount(normalized.totalBalance - expectedFrozen);
        const deficitAmount = expectedAvailable < 0 ? round2Amount(Math.abs(expectedAvailable)) : 0;
        const availableGap = round2Amount(expectedAvailable - normalized.availableBalance);
        const frozenGap = round2Amount(expectedFrozen - normalized.frozenBalance);
        const earningFrozenGap = round2Amount(expectedEarningFrozen - normalized.earningFrozenBalance);
        const withdrawFrozenGap = round2Amount(expectedWithdrawFrozen - normalized.withdrawFrozenBalance);
        const bucketFrozenGap = round2Amount(expectedFrozen - normalized.bucketFrozenBalance);
        const hasNegativeBalance =
            normalized.availableBalance < 0 ||
            normalized.frozenBalance < 0 ||
            normalized.earningFrozenBalance < 0 ||
            normalized.withdrawFrozenBalance < 0;
        const hasIssue =
            deficitAmount > 0 ||
            hasNegativeBalance ||
            Math.abs(availableGap) > 0.009 ||
            Math.abs(frozenGap) > 0.009 ||
            Math.abs(earningFrozenGap) > 0.009 ||
            Math.abs(withdrawFrozenGap) > 0.009 ||
            Math.abs(bucketFrozenGap) > 0.009;

        return {
            userId,
            phone: user?.phone ?? null,
            name: user?.name ?? null,
            userType: user?.userType ?? null,
            status: user?.status ?? null,
            canWithdraw: user?.canWithdraw ?? null,
            currentAvailable: normalized.availableBalance,
            currentFrozen: normalized.frozenBalance,
            currentEarningFrozen: normalized.earningFrozenBalance,
            currentWithdrawFrozen: normalized.withdrawFrozenBalance,
            currentBucketFrozen: normalized.bucketFrozenBalance,
            currentTotal: normalized.totalBalance,
            depositBalance: normalized.depositBalance,
            expectedAvailable,
            expectedFrozen,
            expectedEarningFrozen,
            expectedWithdrawFrozen,
            holdFrozenAmount: expectedEarningFrozen,
            pendingWithdrawAmount: expectedWithdrawFrozen,
            availableGap,
            frozenGap,
            earningFrozenGap,
            withdrawFrozenGap,
            bucketFrozenGap,
            deficitAmount,
            pendingWithdrawCount: Number(pendingCount || 0),
            negativeFrozenSnapshotCount: Number(negativeAgg?._count || 0),
            firstNegativeAt: negativeAgg?._min?.createdAt ?? null,
            lastNegativeAt: negativeAgg?._max?.createdAt ?? null,
            minFrozenAfter: round2Amount(negativeAgg?._min?.frozenAfter),
            hasNegativeBalance,
            hasIssue,
            safeToRepair: deficitAmount <= 0,
        };
    }

    async ensureWalletAccountBucketsReady(
        userId: number,
        tx?: PrismaTx,
        options?: {
            throwOnDeficit?: boolean;
            autoRepairOnDeficit?: boolean;
            repairReason?: string;
            operatorId?: number;
        },
    ) {
        const db = (tx as any) ?? this.prisma;
        const audit = await this.inspectWalletAccountState(userId, db);
        if (!audit.hasIssue) {
            return this.getWalletAccountBalance(userId, db);
        }

        if (audit.deficitAmount > 0) {
            return this.getWalletAccountBalance(userId, db);
        }

        return (db as any).walletAccount.update({
            where: { userId },
            data: buildWalletAccountSetData({
                availableBalance: audit.expectedAvailable,
                earningFrozenBalance: audit.expectedEarningFrozen,
                withdrawFrozenBalance: audit.expectedWithdrawFrozen,
                depositBalance: audit.depositBalance,
            }),
            select: walletAccountBalanceSelect,
        });
    }

    private async buildReplayAuditItem(userId: number) {
        const audit = await this.inspectWalletAccountState(userId, this.prisma as any);
        const replay = await this.previewReplayByUser({
            userId,
            mode: 'full',
            limitMismatches: 100,
        });

        const replayAvailable = round2Amount(replay?.replayBalance?.available);
        const replayFrozen = round2Amount(replay?.replayBalance?.frozen);
        const replayTotal = round2Amount(replay?.replayBalance?.total);
        const totalGap = round2Amount(replayTotal - round2Amount(audit.currentTotal));
        const availableGap = round2Amount(replayAvailable - round2Amount(audit.currentAvailable));
        const frozenGap = round2Amount(replayFrozen - round2Amount(audit.currentFrozen));
        const hasReplayIssue =
            Math.abs(totalGap) > 0.009 ||
            Math.abs(availableGap) > 0.009 ||
            Math.abs(frozenGap) > 0.009;
        const anomalySignature = this.buildWalletAnomalySignature({
            currentAvailable: round2Amount(audit.currentAvailable),
            currentFrozen: round2Amount(audit.currentFrozen),
            currentTotal: round2Amount(audit.currentTotal),
            replayAvailable,
            replayFrozen,
            replayTotal,
            availableGap,
            frozenGap,
            totalGap,
        });

        return {
            ...audit,
            replayAvailable,
            replayFrozen,
            replayTotal,
            availableGap,
            frozenGap,
            totalGap,
            hasIssue: hasReplayIssue,
            anomalyType: Math.abs(totalGap) > 0.009 ? 'TOTAL_MISMATCH' : 'BUCKET_MISMATCH',
            replayAdjustments: replay?.replayAdjustments || null,
            replayStats: replay?.stats || null,
            deficitAmount: totalGap > 0 ? totalGap : 0,
            safeToRepair: totalGap <= 0.009,
            anomalySignature,
        };
    }

    async auditWalletAnomalies(params?: { userId?: number; onlyIssues?: boolean; limit?: number }) {
        const userId = Number(params?.userId || 0);
        const limit = Math.min(1000, Math.max(1, Number(params?.limit || 200)));
        const onlyIssues = params?.onlyIssues !== false;

        const accounts = await this.prisma.walletAccount.findMany({
            where: userId
                ? { userId }
                : {
                    user: {
                        staffEmploymentStatus: {
                            notIn: ['EXITED', 'BLACKLISTED'],
                        },
                    },
                },
            orderBy: { userId: 'asc' },
            take: userId ? undefined : limit,
            select: { userId: true },
        });

        const items: any[] = [];
        for (const row of accounts) {
            const audit = await this.buildReplayAuditItem(Number(row.userId));
            const isRiskIssue = Number(audit?.totalGap || 0) < -0.009;
            if (!onlyIssues || isRiskIssue) {
                items.push(audit);
            }
        }

        const summary = items.reduce(
            (acc, item) => {
                acc.totalUsers += 1;
                if (Number(item.totalGap || 0) < -0.009) acc.deficitUsers += 1;
                if (item.negativeFrozenSnapshotCount > 0) acc.negativeSnapshotUsers += 1;
                if (item.hasNegativeBalance) acc.negativeBalanceUsers += 1;
                acc.totalDeficitAmount = round2Amount(acc.totalDeficitAmount + Math.abs(Number(item.totalGap || 0)));
                return acc;
            },
            {
                totalUsers: 0,
                deficitUsers: 0,
                negativeSnapshotUsers: 0,
                negativeBalanceUsers: 0,
                totalDeficitAmount: 0,
            },
        );

        return {
            generatedAt: new Date().toISOString(),
            onlyIssues,
            scannedUsers: accounts.length,
            returnedUsers: items.length,
            summary,
            items,
        };
    }

    async repairWalletAnomalies(params?: {
        userId?: number;
        apply?: boolean;
        includeDeficitUsers?: boolean;
        limit?: number;
        reason?: string;
        operatorId?: number;
    }) {
        const apply = params?.apply === true;
        const includeDeficitUsers = params?.includeDeficitUsers === true;
        const repairableItems: any[] = [];
        const blockedItems: any[] = [];

        const explicitUserId = Number(params?.userId || 0);
        if (explicitUserId > 0) {
            try {
                const audit = await this.buildReplayAuditItem(explicitUserId);
                repairableItems.push(await this.buildWalletRepairPreviewItem(audit, { reason: params?.reason }));
            } catch (e: any) {
                blockedItems.push({
                    userId: explicitUserId,
                    blockedReason: e?.message || '生成修复预览失败',
                });
            }
        } else {
            const audit = await this.auditWalletAnomalies({
                userId: params?.userId,
                onlyIssues: true,
                limit: params?.limit,
            });

            for (const item of audit.items) {
                try {
                    repairableItems.push(await this.buildWalletRepairPreviewItem(item, { reason: params?.reason }));
                } catch (e: any) {
                    blockedItems.push({
                        ...item,
                        blockedReason: e?.message || '生成修复预览失败',
                    });
                }
            }
        }

        const nonApplyableItems = repairableItems
            .filter((item: any) => item?.repairPreview?.canApplyByReplay !== true)
            .map((item: any) => ({
                ...item,
                blockedReason: `重放修复已阻断：本次修复将上调账户总余额 ${round2Amount(item?.repairPreview?.totalGap)}，存在资金风险，需人工核对。`,
            }));
        const executableItems = repairableItems.filter((item: any) => item?.repairPreview?.canApplyByReplay === true);
        const safeItems = includeDeficitUsers
            ? executableItems
            : executableItems.filter((item: any) => item.safeToRepair);
        const applied: any[] = [];

        if (apply) {
            for (const item of safeItems) {
                applied.push(await this.applyWalletRepairPlan({
                    userId: Number(item.userId),
                    reason: params?.reason,
                    operatorId: params?.operatorId,
                }));
            }
        }

        return {
            generatedAt: new Date().toISOString(),
            apply,
            repairedCount: applied.length,
            safeRepairableCount: safeItems.length,
            blockedCount: blockedItems.length + nonApplyableItems.length,
            blockedItems: includeDeficitUsers
                ? [...blockedItems, ...nonApplyableItems]
                : [...blockedItems, ...nonApplyableItems].slice(0, 50),
            appliedItems: applied,
            previewItems: apply ? [] : repairableItems,
        };
    }

    async rollbackWalletRepairAdjustments(params?: {
        userId?: number;
        apply?: boolean;
        limit?: number;
        onlyBalanceIncrease?: boolean;
        reason?: string;
        operatorId?: number;
    }) {
        const apply = params?.apply === true;
        const onlyBalanceIncrease = params?.onlyBalanceIncrease !== false;
        const groups = await this.collectWalletRepairRollbackCandidates({
            userId: params?.userId,
            limit: params?.limit,
            onlyBalanceIncrease,
        });

        const previewItems: any[] = [];
        const blockedItems: any[] = [];
        for (const group of groups) {
            try {
                const preview = await this.buildWalletRepairRollbackPreviewItem(group, { reason: params?.reason });
                if (preview.canApply) {
                    previewItems.push(preview);
                } else {
                    blockedItems.push(preview);
                }
            } catch (e: any) {
                blockedItems.push({
                    ...group,
                    blockedReason: e?.message || '生成回滚预览失败',
                });
            }
        }

        const appliedItems: any[] = [];
        if (apply) {
            for (const item of previewItems) {
                appliedItems.push(await this.applyWalletRepairRollbackPlan({
                    preview: item,
                    reason: params?.reason,
                    operatorId: params?.operatorId,
                }));
            }
        }

        return {
            generatedAt: new Date().toISOString(),
            apply,
            onlyBalanceIncrease,
            rollbackableCount: previewItems.length,
            blockedCount: blockedItems.length,
            appliedCount: appliedItems.length,
            blockedItems,
            appliedItems,
            previewItems: apply ? [] : previewItems,
        };
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
                    data: {
                        userId,
                        walletUid: uid,
                        availableBalance: 0,
                        frozenBalance: 0,
                        earningFrozenBalance: 0,
                        withdrawFrozenBalance: 0,
                        depositBalance: 0,
                    },
                });
            } catch (e: any) {
                if (e?.code === 'P2002') continue;
                throw e;
            }
        }

        throw new Error('Failed to create wallet account with unique walletUid');
    }

    async creditAvailableBalance(
        params: {
            userId: number;
            amount: number;
            bizType: WalletBizType;
            sourceType: string;
            sourceId: number;
            remark?: string;
        },
        tx?: PrismaTx,
    ) {
        const amount = round2(Number(params.amount || 0));
        if (amount <= 0) throw new BadRequestException('入账金额必须大于 0');

        const runner = async (db: any) => {
            await this.ensureWalletAccount(params.userId, db);

            const existing = await db.walletTransaction.findUnique({
                where: {
                    sourceType_sourceId: {
                        sourceType: params.sourceType,
                        sourceId: params.sourceId,
                    },
                },
            });
            if (existing) return existing;

            const accountAfter = await db.walletAccount.update({
                where: { userId: params.userId },
                data: {
                    availableBalance: { increment: amount },
                },
                select: walletAccountBalanceSelect,
            });

            return db.walletTransaction.create({
                data: {
                    userId: params.userId,
                    direction: WalletDirection.IN,
                    bizType: params.bizType,
                    amount,
                    status: WalletTxStatus.AVAILABLE,
                    sourceType: params.sourceType,
                    sourceId: params.sourceId,
                    availableAfter: round2(Number(accountAfter?.availableBalance ?? 0)),
                    frozenAfter: round2(Number(accountAfter?.frozenBalance ?? 0)),
                } as any,
            });
        };

        if (tx) return runner(tx);
        return this.prisma.$transaction(async (db) => runner(db as any));
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
            await this.ensureWalletAccountBucketsReady(params.userId, t as any);

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
                    await this.applyWalletAccountDelta(t as any, params.userId, {
                        earningFrozenDelta: Number(earningTx.amount || 0),
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
                            await this.applyWalletAccountDelta(t as any, params.userId, {
                                earningFrozenDelta: delta,
                            });
                        } else if (delta < 0) {
                            await this.applyWalletAccountDelta(t as any, params.userId, {
                                earningFrozenDelta: delta,
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
     * ✅ 幂等修复 settlement 的冻结收益钱包流水
     * 目标：让 walletTx.amount == expectedAmount，且不会重复计入余额
     *
     * 约束：
     * - 若 walletTx/hold 已非冻结：由上层拦截，不在这里处理
     */
    async repairSettlementEarning(
        params: {
            userId: number;
            expectedAmount: number;
            sourceType: 'ORDER_SETTLEMENT';
            sourceId: number;
            orderId: number;
            dispatchId: number | null;
            settlementId: number;
        },
        tx: any,
    ) {
        const { userId, expectedAmount, sourceType, sourceId, orderId, dispatchId, settlementId } = params;

        const expected = Number(expectedAmount ?? 0);
        if (!Number.isFinite(expected) || expected === 0) return;

        const isNegative = expected < 0;

        await this.ensureWalletAccountBucketsReady(userId, tx as any);

        // 1️⃣ 查现有流水（幂等锚点）
        const existing = await tx.walletTransaction.findUnique({
            where: { sourceType_sourceId: { sourceType, sourceId } },
            select: { id: true, amount: true, status: true },
        });

        /**
         * =========================
         * A. 不存在流水 → 补建
         * =========================
         */
        if (!existing) {
            if (isNegative) {
                // 🔻 炸单损耗：即时生效
                await tx.walletAccount.upsert({
                    where: { userId },
                    update: { availableBalance: { increment: expected } } as any,
                    create: {
                        userId,
                        availableBalance: expected,
                        frozenBalance: 0,
                        earningFrozenBalance: 0,
                        withdrawFrozenBalance: 0,
                    } as any,
                });

                const walletAmount = Math.abs(expected);

                await tx.walletTransaction.create({
                    data: {
                        userId,
                        amount: walletAmount,
                        status: 'AVAILABLE', // ✅ enum 对齐
                        direction: WalletDirection.OUT,
                        bizType: WalletBizType.SETTLEMENT_BOMB_LOSS,
                        sourceType,
                        sourceId,
                        orderId,
                        dispatchId,
                        settlementId,
                    } as any,
                });

                return;
            }

            // 🔺 正数收益：冻结
            await tx.walletAccount.upsert({
                where: { userId },
                update: buildWalletAccountDeltaData({ earningFrozenDelta: expected }) as any,
                create: {
                    userId,
                    availableBalance: 0,
                    frozenBalance: expected,
                    earningFrozenBalance: expected,
                    withdrawFrozenBalance: 0,
                } as any,
            });

            const txRow = await tx.walletTransaction.create({
                data: {
                    userId,
                    amount: expected,
                    status: 'FROZEN',
                    direction: WalletDirection.IN,
                    bizType: WalletBizType.SETTLEMENT_EARNING_BASE, // 或你传入的具体收益类型
                    sourceType,
                    sourceId,
                    orderId,
                    dispatchId,
                    settlementId,
                } as any,
                select: { id: true },
            });

            await tx.walletHold.create({
                data: {
                    earningTxId: txRow.id,
                    userId,
                    amount: expected,
                    status: 'FROZEN',
                    unlockAt: new Date(),
                } as any,
            });

            return;
        }

        /**
         * =========================
         * B. 已存在流水 → 对齐
         * =========================
         */
        const current = Number(existing.amount ?? 0);
        if (current === expected && (
            (isNegative && existing.status === 'AVAILABLE') ||
            (!isNegative && existing.status === 'FROZEN')
        )) {
            return; // 已对齐
        }

        // 旧影响
        const oldFrozen = existing.status === 'FROZEN' ? current : 0;
        const oldAvail = existing.status === 'AVAILABLE' ? current : 0;

        // 新影响
        const newFrozen = isNegative ? 0 : expected;
        const newAvail = isNegative ? expected : 0;

        const deltaFrozen = newFrozen - oldFrozen;
        const deltaAvail = newAvail - oldAvail;

        // 1️⃣ 调整账户余额（幂等核心）
        await this.applyWalletAccountDelta(tx as any, userId, {
            earningFrozenDelta: deltaFrozen,
            availableDelta: deltaAvail,
        });

        // 2️⃣ 更新流水
        await tx.walletTransaction.update({
            where: { id: existing.id },
            data: {
                amount: expected,
                status: isNegative ? 'AVAILABLE' : 'FROZEN',
                direction: isNegative ? WalletDirection.OUT : WalletDirection.IN,
                bizType: isNegative
                    ? WalletBizType.SETTLEMENT_BOMB_LOSS
                    : WalletBizType.SETTLEMENT_EARNING_BASE,
            } as any,
        });

        // 3️⃣ hold 处理
        const hold = await tx.walletHold.findUnique({
            where: { earningTxId: existing.id },
            select: { id: true },
        });

        if (isNegative) {
            // 🔻 炸单损耗：不应存在 hold
            if (hold) {
                await tx.walletHold.delete({ where: { id: hold.id } });
            }
        } else {
            // 🔺 正数收益：确保 hold 存在且金额正确
            if (hold) {
                await tx.walletHold.update({
                    where: { id: hold.id },
                    data: { amount: expected } as any,
                });
            } else {
                await tx.walletHold.create({
                    data: {
                        earningTxId: existing.id,
                        userId,
                        amount: expected,
                        status: 'FROZEN',
                        unlockAt: new Date(),
                    } as any,
                });
            }
        }
    }

    /**
     * ✅ repairSettlementEarningV1（新增，不影响旧方法）
     * 幂等修复 settlement 对应的钱包流水（支持 expectedAmount 正/负）
     *
     * 目标：
     * - 让“钱包对余额的效果金额(effect)” == expectedAmount
     *   - expectedAmount > 0 ：冻结收益（FROZEN + IN），并且存在 hold(FROZEN)
     *   - expectedAmount < 0 ：即时扣款（AVAILABLE + OUT），并且不应存在 hold
     *
     * 关键约定（你已确认）：
     * - WalletTransaction.amount 永远为正数（abs）
     * - 入/出由 direction=IN/OUT 表达
     *
     * 幂等核心：
     * - 先把 existing walletTx 转成“旧效果金额 oldEffect”（带符号）
     * - 再把 expectedAmount 作为“新效果金额 newEffect”
     * - 计算冻结余额/可用余额的 delta，只做差额调整，不重复入账
     *
     * 上层约束：
     * - 若 walletTx/hold 已非允许状态（例如正数收益已解冻/已入账），应由上层拦截并 blocked
     */
    async repairSettlementEarningV1(
        params: {
            userId: number;
            expectedAmount: number; // “效果金额”：正数=收益，负数=扣款
            sourceType: 'ORDER_SETTLEMENT';
            sourceId: number;
            orderId: number;
            dispatchId: number | null;
            settlementId: number;
        },
        tx: any,
    ) {
        const { userId, expectedAmount, sourceType, sourceId, orderId, dispatchId, settlementId } = params;

        // ✅ 与 Decimal(10,1) 对齐：统一 1 位小数，降低浮点噪声扩散
        const round1 = (n: number) => Math.round(n * 10) / 10;

        const newEffect = round1(toNum(expectedAmount ?? 0)); // ✅ 可正可负：对余额的最终效果
        if (!Number.isFinite(newEffect) || newEffect === 0) return;

        await this.ensureWalletAccountBucketsReady(userId, tx as any);

        const isNegative = newEffect < 0;
        const newAbs = round1(Math.abs(newEffect)); // ✅ walletTx.amount 永远写正数

        /**
         * 1️⃣ 查现有流水（幂等锚点）
         */
        const existing = await tx.walletTransaction.findUnique({
            where: { sourceType_sourceId: { sourceType, sourceId } },
            select: { id: true, amount: true, status: true, direction: true },
        });

        /**
         * 把 walletTx 转为“对余额的旧效果金额 oldEffect（带符号）”
         * - amount 永远正
         * - IN => +amount
         * - OUT => -amount
         */
        const toEffect = (row: any) => {
            const abs = round1(Math.abs(toNum(row?.amount ?? 0)));
            if (!abs) return 0;
            return row?.direction === WalletDirection.OUT ? -abs : abs;
        };

        /**
         * =========================
         * A. 不存在流水 → 补建
         * =========================
         */
        if (!existing) {
            if (isNegative) {
                // 🔻 负数：即时扣款（AVAILABLE + OUT），不应存在 hold
                const account = await tx.walletAccount.upsert({
                    where: { userId },
                    update: { availableBalance: { increment: newEffect } } as any, // newEffect < 0
                    create: {
                        userId,
                        availableBalance: newEffect,
                        frozenBalance: 0,
                        earningFrozenBalance: 0,
                        withdrawFrozenBalance: 0,
                    } as any,
                    select: walletAccountBalanceSelect,
                });

                await tx.walletTransaction.create({
                    data: {
                        userId,
                        amount: newAbs, // ✅ 正数
                        status: 'AVAILABLE',
                        direction: WalletDirection.OUT,
                        bizType: WalletBizType.SETTLEMENT_BOMB_LOSS,
                        sourceType,
                        sourceId,
                        orderId,
                        dispatchId,
                        settlementId,

                        // ✅ 余额快照：本笔入账后的余额
                        availableAfter: account.availableBalance,
                        frozenAfter: account.frozenBalance,
                    } as any,
                });

                return;
            }

            // 🔺 正数：冻结收益（FROZEN + IN），必须创建 hold
            const account = await tx.walletAccount.upsert({
                where: { userId },
                update: buildWalletAccountDeltaData({ earningFrozenDelta: newEffect }) as any,
                create: {
                    userId,
                    availableBalance: 0,
                    frozenBalance: newEffect,
                    earningFrozenBalance: newEffect,
                    withdrawFrozenBalance: 0,
                } as any,
                select: walletAccountBalanceSelect,
            });

            const txRow = await tx.walletTransaction.create({
                data: {
                    userId,
                    amount: newAbs, // ✅ 正数
                    status: 'FROZEN',
                    direction: WalletDirection.IN,
                    bizType: WalletBizType.SETTLEMENT_EARNING_BASE,
                    sourceType,
                    sourceId,
                    orderId,
                    dispatchId,
                    settlementId,

                    availableAfter: account.availableBalance,
                    frozenAfter: account.frozenBalance,
                } as any,
                select: { id: true },
            });

            await tx.walletHold.create({
                data: {
                    earningTxId: txRow.id,
                    userId,
                    amount: newAbs, // ✅ hold.amount 也保持正数
                    status: 'FROZEN',
                    unlockAt: new Date(),
                } as any,
            });

            return;
        }

        /**
         * =========================
         * B. 已存在流水 → 对齐（幂等）
         * =========================
         *
         * 注意：
         * - existing.amount 可能与 direction/status 不一致（历史脏数据），
         *   我们依旧以 direction 推导 oldEffect，以保证“按效果对齐”的幂等性。
         */
        const oldEffect = round1(toEffect(existing)); // 带符号
        if (oldEffect === newEffect) {
            // 金额效果已一致：这里可做“关系兜底”
            const hold = await tx.walletHold.findUnique({
                where: { earningTxId: existing.id },
                select: { id: true },
            });

            if (isNegative) {
                // 负数：确保无 hold
                if (hold) await tx.walletHold.delete({ where: { id: hold.id } });
            } else {
                // 正数：确保有 hold（金额对齐）
                if (hold) {
                    await tx.walletHold.update({ where: { id: hold.id }, data: { amount: newAbs } as any });
                } else {
                    await tx.walletHold.create({
                        data: { earningTxId: existing.id, userId, amount: newAbs, status: 'FROZEN', unlockAt: new Date() } as any,
                    });
                }
            }
            return;
        }

        /**
         * 旧影响拆分到余额维度：
         * - 正数收益应当影响 frozenBalance（+）
         * - 负数扣款应当影响 availableBalance（-）
         *
         * 这里用 “existing.status” 来归类旧影响：
         * - existing.status === 'FROZEN'    => oldFrozen = |oldEffect|
         * - existing.status === 'AVAILABLE' => oldAvail  = oldEffect（可能为负）
         *
         * 说明：我们不允许一个流水同时影响两种余额；因此根据 status 选择其归属。
         */
        const oldFrozen = existing.status === 'FROZEN' ? round1(Math.abs(oldEffect)) : 0;
        const oldAvail = existing.status === 'AVAILABLE' ? round1(oldEffect) : 0;

        // 新影响：
        const newFrozen = isNegative ? 0 : newAbs;
        const newAvail = isNegative ? newEffect : 0; // 负数

        const deltaFrozen = round1(newFrozen - oldFrozen);
        const deltaAvail = round1(newAvail - oldAvail);

        /**
         * 1️⃣ 调整账户余额（幂等核心）
         * - 必须 upsert：避免历史没有 walletAccount 的用户导致 update 抛错
         */
        const account = await tx.walletAccount.upsert({
            where: { userId },
            update: buildWalletAccountDeltaData({
                earningFrozenDelta: deltaFrozen,
                availableDelta: deltaAvail,
            }) as any,
            create: {
                userId,
                availableBalance: deltaAvail,
                frozenBalance: deltaFrozen,
                earningFrozenBalance: deltaFrozen,
                withdrawFrozenBalance: 0,
            } as any,
            select: walletAccountBalanceSelect,
        });

        /**
         * 2️⃣ 更新流水（牢记：amount 永远正数）
         */
        await tx.walletTransaction.update({
            where: { id: existing.id },
            data: {
                amount: newAbs, // ✅ 正数
                status: isNegative ? 'AVAILABLE' : 'FROZEN',
                direction: isNegative ? WalletDirection.OUT : WalletDirection.IN,
                bizType: isNegative ? WalletBizType.SETTLEMENT_BOMB_LOSS : WalletBizType.SETTLEMENT_EARNING_BASE,

                // ✅ 余额快照：对齐后的余额
                availableAfter: account.availableBalance,
                frozenAfter: account.frozenBalance,
            } as any,
        });

        /**
         * 3️⃣ hold 处理（关系修复）
         */
        const hold = await tx.walletHold.findUnique({
            where: { earningTxId: existing.id },
            select: { id: true },
        });

        if (isNegative) {
            // 🔻 负数扣款：不应存在 hold
            if (hold) await tx.walletHold.delete({ where: { id: hold.id } });
        } else {
            // 🔺 正数收益：必须存在 hold 且金额正确
            if (hold) {
                await tx.walletHold.update({ where: { id: hold.id }, data: { amount: newAbs } as any });
            } else {
                await tx.walletHold.create({
                    data: {
                        earningTxId: existing.id,
                        userId,
                        amount: newAbs,
                        status: 'FROZEN',
                        unlockAt: new Date(),
                    } as any,
                });
            }
        }
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
    }, tx?: Prisma.TransactionClient)
    {
        const db = (tx as any) ?? this.prisma;

        // 找到该订单下所有“结算收益流水”
        const earningTxs = await db.walletTransaction.findMany({
            where: {
                orderId: params.orderId,
                sourceType: 'ORDER_SETTLEMENT',
                bizType: {
                    in: [
                        WalletBizType.SETTLEMENT_EARNING,
                        WalletBizType.SETTLEMENT_EARNING_BASE,
                        WalletBizType.SETTLEMENT_EARNING_CARRY,
                        WalletBizType.SETTLEMENT_EARNING_CS,
                        WalletBizType.SETTLEMENT_BOMB_LOSS,
                    ],
                },
            },
            select: {
                id: true,
                userId: true,
                amount: true,
                status: true,
                direction: true,
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
                await this.ensureWalletAccountBucketsReady(earningTx.userId, t as any);

                // 是否有冻结单
                const hold = await t.walletHold.findUnique({
                    where: { earningTxId: earningTx.id },
                    select: { id: true, status: true, amount: true },
                });

                const amount = Math.round(Number(earningTx.amount) * 100) / 100;
                const isOut = earningTx.direction === WalletDirection.OUT;

                // 情况 1：收益还在冻结中（典型：未到 unlockAt 就退款）
                if (earningTx.status === WalletTxStatus.FROZEN) {
                    // 1.1 回退 frozenBalance（方向反向）
                    if (isOut) {
                        await this.applyWalletAccountDelta(t as any, earningTx.userId, {
                            earningFrozenDelta: amount,
                        });
                    } else {
                        await this.applyWalletAccountDelta(t as any, earningTx.userId, {
                            earningFrozenDelta: -amount,
                        });
                    }

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
                    const reversalDirection = isOut ? WalletDirection.IN : WalletDirection.OUT;

                    // 2.1 生成冲正流水（OUT）
                    await t.walletTransaction.create({
                        data: {
                            userId: earningTx.userId,
                            direction: reversalDirection,
                            bizType: WalletBizType.REFUND_REVERSAL,
                            amount,
                            status: WalletTxStatus.AVAILABLE, // 冲正立即生效
                            sourceType: 'REFUND_REVERSAL',
                            sourceId: earningTx.id,
                            reversalOfTxId: earningTx.id,
                            orderId: params.orderId,
                        },
                    });

                    // 2.2 回退 availableBalance（方向反向）
                    if (reversalDirection === WalletDirection.OUT) {
                        await t.walletAccount.update({
                            where: { userId: earningTx.userId },
                            data: { availableBalance: { decrement: amount } },
                        });
                    } else {
                        await t.walletAccount.update({
                            where: { userId: earningTx.userId },
                            data: { availableBalance: { increment: amount } },
                        });
                    }

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
                    await this.ensureWalletAccountBucketsReady(hold.userId, tx as any);

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
                        const earning = await tx.walletTransaction.findUnique({
                            where: { id: hold.earningTxId },
                            select: { orderId: true, dispatchId: true, settlementId: true },
                        });
                        // 1) 先创建解冻流水（不写快照，等 account 更新后回写）
                        const releaseTx = await tx.walletTransaction.create({
                            data: {
                                userId: hold.userId,
                                direction: 'IN',
                                bizType: 'RELEASE_FROZEN',
                                amount,
                                status: 'AVAILABLE',
                                sourceType: releaseSourceType,
                                sourceId: hold.earningTxId,
                                // ✅ 关键：补齐订单维度冗余字段
                                orderId: earning?.orderId ?? null,
                                dispatchId: earning?.dispatchId ?? null,
                                settlementId: earning?.settlementId ?? null,
                            },
                            select: { id: true },
                        });

                        // 2) 更新账户余额：frozen-- available++
                        const accountAfter = await this.applyWalletAccountDelta(tx as any, hold.userId, {
                            earningFrozenDelta: -amount,
                            availableDelta: amount,
                        });

                        // 3) ✅ 回写余额快照（本笔落账后的余额）
                        await tx.walletTransaction.update({
                            where: { id: releaseTx.id },
                            data: {
                                availableAfter: round2(Number((accountAfter as any).availableBalance ?? 0)),
                                frozenAfter: round2(Number((accountAfter as any).frozenBalance ?? 0)),
                            },
                        });

                        // 4) 同步把原收益流水标记为 AVAILABLE
                        // ⚠️ 不要覆盖原收益流水的 availableAfter/frozenAfter：
                        //    这些快照对应“冻结入账时点”的历史状态，覆盖会污染历史账面基数。
                        await tx.walletTransaction.update({
                            where: { id: hold.earningTxId },
                            data: {
                                status: 'AVAILABLE',
                            },
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
        await this.ensureWalletAccountBucketsReady(userId, this.prisma as any, { throwOnDeficit: false });

        return this.prisma.walletAccount.findUnique({
            where: { userId },
            select: walletAccountBalanceSelect,
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
        const includeReleaseFrozen =
            query?.includeReleaseFrozen === true ||
            String((query as any)?.includeReleaseFrozen ?? '').toLowerCase() === 'true';

        if (query.direction) where.direction = query.direction;
        if (query.status) where.status = query.status;

        if (query.orderId) where.orderId = Number(query.orderId);
        if (query.dispatchId) where.dispatchId = Number(query.dispatchId);

        // ✅ 新增：按订单编号 autoSerial 反查 orderId
        if (query.orderAutoSerial) {
            const keyword = String(query.orderAutoSerial).trim();

            if (keyword) {
                const matchedOrders = await this.prisma.order.findMany({
                    where: {
                        autoSerial: {
                            contains: keyword, // 若你要精确匹配可改成 equals: keyword
                        },
                    },
                    select: { id: true },
                });

                const matchedOrderIds = matchedOrders.map((o) => Number(o.id));

                // 没有匹配到订单，直接让结果为空
                if (matchedOrderIds.length === 0) {
                    where.orderId = -1;
                } else {
                    // 如果前面已经传了 orderId，则取交集逻辑
                    if (where.orderId) {
                        if (matchedOrderIds.includes(Number(where.orderId))) {
                            where.orderId = Number(where.orderId);
                        } else {
                            where.orderId = -1;
                        }
                    } else {
                        where.orderId = { in: matchedOrderIds };
                    }
                }
            }
        }

        // 时间范围（createdAt）
        if (query.startAt || query.endAt) {
            where.createdAt = {};
            if (query.startAt) where.createdAt.gte = new Date(query.startAt);
            if (query.endAt) where.createdAt.lte = new Date(query.endAt);
        }

        // 默认排除解冻流水；如指定 bizType 则按显式筛选
        if (query.bizType) {
            where.bizType = query.bizType;
        } else if (!includeReleaseFrozen) {
            where.bizType = { not: 'RELEASE_FROZEN' };
        }

        // 用于返回“默认隐藏的解冻流水汇总”
        const releaseHiddenWhere: any = { ...where };
        delete releaseHiddenWhere.bizType;
        releaseHiddenWhere.bizType = 'RELEASE_FROZEN';

        // ✅ 2) 先查当前账户余额（作为“本页最新余额锚点”）
        await this.ensureWalletAccount(userId, this.prisma as any);
        const accountNow = await this.prisma.walletAccount.findUnique({
            where: { userId },
            select: { availableBalance: true, frozenBalance: true, depositBalance: true },
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

                    // ✅ Wallet v0.3：余额快照（可能为空，历史记录兼容）
                    availableAfter: true,
                    frozenAfter: true,

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

        // ✅ 2.5) 本页批量补订单编号 autoSerial（不改 schema，不做 relation）
        const orderIds = Array.from(
            new Set(
                (rows || [])
                    .map((r: any) => Number(r?.orderId))
                    .filter((n: number) => Number.isFinite(n) && n > 0),
            ),
        );

        let orderSerialMap = new Map<number, string>();
        if (orderIds.length > 0) {
            const orders = await this.prisma.order.findMany({
                where: { id: { in: orderIds } },
                select: { id: true, autoSerial: true },
            });
            orderSerialMap = new Map<number, string>(
                orders.map((o: any) => [Number(o.id), String(o.autoSerial ?? '')]),
            );
        }

        // 为结算主流水补冻结单状态，替代直接展示 RELEASE_FROZEN 明细
        const settlementTxIds = Array.from(
            new Set(
                (rows || [])
                    .filter((r: any) =>
                        [
                            'SETTLEMENT_EARNING',
                            'SETTLEMENT_EARNING_BASE',
                            'SETTLEMENT_EARNING_CARRY',
                            'SETTLEMENT_EARNING_CS',
                        ].includes(String(r?.bizType || '')),
                    )
                    .map((r: any) => Number(r?.id))
                    .filter((n: number) => Number.isFinite(n) && n > 0),
            ),
        );

        let holdMap = new Map<number, { status: string; unlockAt: Date; releasedAt: Date | null }>();
        if (settlementTxIds.length > 0) {
            const holds = await this.prisma.walletHold.findMany({
                where: { earningTxId: { in: settlementTxIds } },
                select: { earningTxId: true, status: true, unlockAt: true, releasedAt: true },
            });
            holdMap = new Map(
                holds.map((h: any) => [
                    Number(h.earningTxId),
                    { status: String(h.status), unlockAt: h.unlockAt, releasedAt: h.releasedAt ?? null },
                ]),
            );
        }

        let hiddenReleaseSummary = { count: 0, amount: 0 };
        if (!query.bizType && !includeReleaseFrozen) {
            const releaseAgg = await this.prisma.walletTransaction.aggregate({
                where: releaseHiddenWhere,
                _count: { _all: true },
                _sum: { amount: true },
            });
            hiddenReleaseSummary = {
                count: Number(releaseAgg?._count?._all ?? 0),
                amount: round2(Number((releaseAgg?._sum?.amount as any) ?? 0)),
            };
        }

        // ✅ 3) 计算每条流水对 “available / frozen” 的影响（用 bizType，不用 status）
        const toNum = (v: any) => {
            const n = Number(v ?? 0);
            return Number.isFinite(n) ? n : 0;
        };

        const calcDelta = (tx: any) => {
            const amt = toNum(tx.amount);
            const biz = tx.bizType;

            let deltaAvailable = 0;
            let deltaFrozen = 0;

            if (tx.status === 'REVERSED') {
                return { deltaAvailable: 0, deltaFrozen: 0 };
            }

            if (
                biz === 'SETTLEMENT_EARNING' ||
                biz === 'SETTLEMENT_EARNING_BASE' ||
                biz === 'SETTLEMENT_EARNING_CARRY' ||
                biz === 'SETTLEMENT_EARNING_CS'
            ) {
                // 仅冻结态收益影响 frozen；若已 AVAILABLE/REVERSED 不应再计入 frozen 变化
                if (tx.status === 'FROZEN' && tx.direction === 'IN' && amt > 0) deltaFrozen += amt;
                return { deltaAvailable, deltaFrozen };
            }

            if (biz === 'SETTLEMENT_BOMB_LOSS') {
                if (amt > 0) deltaAvailable -= amt;
                return { deltaAvailable, deltaFrozen };
            }

            if (biz === 'RELEASE_FROZEN') {
                if (amt > 0) {
                    deltaFrozen -= amt;
                    deltaAvailable += amt;
                }
                return { deltaAvailable, deltaFrozen };
            }

            if (biz === 'WITHDRAW_RESERVE') {
                if (amt > 0) {
                    deltaAvailable -= amt;
                    deltaFrozen += amt;
                }
                return { deltaAvailable, deltaFrozen };
            }

            if (biz === 'WITHDRAW_RELEASE') {
                if (amt > 0) {
                    deltaFrozen -= amt;
                    deltaAvailable += amt;
                }
                return { deltaAvailable, deltaFrozen };
            }

            if (biz === 'WITHDRAW_PAYOUT') {
                if (amt > 0) {
                    deltaFrozen -= amt;
                }
                return { deltaAvailable, deltaFrozen };
            }

            if (biz === 'REFUND_REVERSAL') {
                if (amt > 0) {
                    if (tx.direction === 'IN') deltaAvailable += amt;
                    if (tx.direction === 'OUT') deltaAvailable -= amt;
                }
                return { deltaAvailable, deltaFrozen };
            }

            if (biz === 'SETTLEMENT_RECALC' || biz === 'SETTLEMENT_REVERSAL') {
                if (amt > 0) {
                    if (tx.status === 'FROZEN') {
                        if (tx.direction === 'IN') deltaFrozen += amt;
                        if (tx.direction === 'OUT') deltaFrozen -= amt;
                    } else if (tx.status === 'AVAILABLE') {
                        if (tx.direction === 'IN') deltaAvailable += amt;
                        if (tx.direction === 'OUT') deltaAvailable -= amt;
                    }
                }
                return { deltaAvailable, deltaFrozen };
            }

            if (biz === 'OFFLINE_FEE_PAYMENT' || biz === 'DEPOSIT_ADD' || biz === 'DEPOSIT_DEDUCT') {
                if (amt > 0) {
                    if (tx.direction === 'IN') deltaAvailable += amt;
                    if (tx.direction === 'OUT') deltaAvailable -= amt;
                }
                return { deltaAvailable, deltaFrozen };
            }

            return { deltaAvailable, deltaFrozen };
        };

        // ✅ 4) 从“当前余额”倒推本页每条 before/after（只保证本页内一致）
        let availAfter = toNum(accountNow?.availableBalance);
        let frozenAfter = toNum(accountNow?.frozenBalance);

        const enriched = (rows || []).map((r: any) => {
            const { deltaAvailable, deltaFrozen } = calcDelta(r);

            const storedAvailAfter = r.availableAfter;
            const storedFrozenAfter = r.frozenAfter;

            const availableAfter =
                storedAvailAfter !== null && storedAvailAfter !== undefined ? toNum(storedAvailAfter) : availAfter;
            const frozenAfterV =
                storedFrozenAfter !== null && storedFrozenAfter !== undefined ? toNum(storedFrozenAfter) : frozenAfter;

            const availableBefore = Number((availableAfter - deltaAvailable).toFixed(2));
            const frozenBefore = Number((frozenAfterV - deltaFrozen).toFixed(2));

            availAfter = availableBefore;
            frozenAfter = frozenBefore;

            const oid = Number(r?.orderId);
            const orderAutoSerial =
                Number.isFinite(oid) && oid > 0 ? (orderSerialMap.get(oid) || null) : null;
            const hold = holdMap.get(Number(r.id));

            return {
                ...r,
                orderAutoSerial,
                holdStatus: hold?.status ?? null,
                holdUnlockAt: hold?.unlockAt ?? null,
                holdReleasedAt: hold?.releasedAt ?? null,
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
            filters: {
                includeReleaseFrozen,
                releaseHiddenByDefault: !query.bizType && !includeReleaseFrozen,
                hiddenReleaseSummary,
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
        await this.applyWalletAccountDelta(db as any, params.userId, {
            earningFrozenDelta: deltaFrozen,
            availableDelta: deltaAvail,
        });

        // 8) ✅ 写入余额快照（本笔落账后的余额）
        // - 必须在同一个事务里完成（db 可能是 tx）
        const accountAfter = await db.walletAccount.findUnique({
            where: { userId: params.userId },
            select: { availableBalance: true, frozenBalance: true },
        });

        if (accountAfter) {
            await db.walletTransaction.update({
                where: { id: earningTx.id },
                data: {
                    availableAfter: round2(Number((accountAfter as any).availableBalance ?? 0)),
                    frozenAfter: round2(Number((accountAfter as any).frozenBalance ?? 0)),
                },
            });
        }

        return { tx: earningTx };
    }

    /**
     * 单用户钱包流水重放预核算（只读，不修改任何余额）
     * - 按 createdAt ASC, id ASC 重放
     * - 默认包含全量历史；可按 startAt/endAt 限定范围
     * - 业务约束（当前核查口径）：
     *   提现预扣 / 提现释放仅作为过程流水，预核算余额不采信；
     *   提现只以最终出款流水 WITHDRAW_PAYOUT 为准。
     */
    async previewReplayByUser(params: {
        userId: number;
        startAt?: string;
        endAt?: string;
        limitMismatches?: number;
        mode?: 'legacy' | 'full';
    }) {
        const userId = Number(params?.userId || 0);
        if (!userId) throw new BadRequestException('userId 必填');

        await this.ensureWalletAccount(userId, this.prisma as any);

        const toNum = (v: any) => {
            const n = Number(v ?? 0);
            return Number.isFinite(n) ? n : 0;
        };
        const r2 = (n: any) => round2(toNum(n));
        const mismatchLimit = Math.min(500, Math.max(20, Number(params?.limitMismatches ?? 100)));
        const replayMode = String(params?.mode || 'full').trim().toLowerCase() === 'legacy' ? 'legacy' : 'full';

        const noBalanceBizSet = replayMode === 'legacy'
            ? new Set<string>([
                'WITHDRAW_PAYOUT',
                'WITHDRAW_RESERVE',
                'WITHDRAW_RELEASE',
                'RELEASE_FROZEN',
            ])
            : new Set<string>([]);
        const settlementBizSet = new Set<string>([
            'SETTLEMENT_EARNING',
            'SETTLEMENT_EARNING_BASE',
            'SETTLEMENT_EARNING_CARRY',
            'SETTLEMENT_EARNING_CS',
            'SETTLEMENT_RECALC',
        ]);

        const loadReleaseSourceStatusMap = async (rows: Array<{ bizType?: string | null; sourceId?: number | null }>) => {
            const sourceIds = Array.from(
                new Set(
                    rows
                        .filter((row) => String(row?.bizType || '') === 'RELEASE_FROZEN')
                        .map((row) => Number(row?.sourceId || 0))
                        .filter((id) => Number.isFinite(id) && id > 0),
                ),
            );

            if (!sourceIds.length) {
                return new Map<number, { status: string; bizType: string }>();
            }

            const sourceRows = await this.prisma.walletTransaction.findMany({
                where: { id: { in: sourceIds } },
                select: { id: true, status: true, bizType: true },
            });

            return new Map<number, { status: string; bizType: string }>(
                sourceRows.map((row) => [
                    Number(row.id),
                    { status: String(row.status || ''), bizType: String(row.bizType || '') },
                ]),
            );
        };

        const loadWithdrawalRequestStatusMap = async (rows: Array<{ bizType?: string | null; sourceId?: number | null }>) => {
            const requestIds = Array.from(
                new Set(
                    rows
                        .filter((row) =>
                            ['WITHDRAW_RESERVE', 'WITHDRAW_RELEASE', 'WITHDRAW_PAYOUT'].includes(String(row?.bizType || '')),
                        )
                        .map((row) => Number(row?.sourceId || 0))
                        .filter((id) => Number.isFinite(id) && id > 0),
                ),
            );

            if (!requestIds.length) {
                return new Map<number, string>();
            }

            const requestRows = await this.prisma.walletWithdrawalRequest.findMany({
                where: { id: { in: requestIds } },
                select: { id: true, status: true },
            });

            return new Map<number, string>(requestRows.map((row) => [Number(row.id), String(row.status || '')]));
        };

        let releaseSourceStatusMap = new Map<number, { status: string; bizType: string }>();
        let withdrawalRequestStatusMap = new Map<number, string>();

        const applyDelta = (
            row: {
                id?: number | null;
                bizType?: string | null;
                status?: string | null;
                direction?: string | null;
                amount?: number | null;
                sourceId?: number | null;
                available?: number;
                earningFrozen?: number;
                withdrawFrozen?: number;
            },
        ) => {
            const biz = String(row?.bizType || '');
            const status = String(row?.status || '');
            const direction = String(row?.direction || '');
            const amount = r2(row?.amount);
            const sourceType = String((row as any)?.sourceType || '');
            let available = r2((row as any)?.available);
            let earningFrozen = r2((row as any)?.earningFrozen);
            let withdrawFrozen = r2((row as any)?.withdrawFrozen);

            if (sourceType.startsWith('WALLET_ANOMALY_REPAIR')) {
                return {
                    available,
                    earningFrozen,
                    withdrawFrozen,
                    deltaAvailable: 0,
                    deltaFrozen: 0,
                    ignored: true,
                    ignoredReason: 'ANOMALY_REPAIR_TX' as const,
                };
            }

            // 指定类型仅做“范围统计”，不改余额
            if (noBalanceBizSet.has(biz)) {
                return {
                    available,
                    earningFrozen,
                    withdrawFrozen,
                    deltaAvailable: 0,
                    deltaFrozen: 0,
                    ignored: true,
                    ignoredReason: 'BIZ_NO_BALANCE' as const,
                };
            }

            if (status === 'REVERSED') {
                return {
                    available,
                    earningFrozen,
                    withdrawFrozen,
                    deltaAvailable: 0,
                    deltaFrozen: 0,
                    ignored: true,
                    ignoredReason: 'REVERSED' as const,
                };
            }

            if (biz === 'WITHDRAW_RESERVE') {
                const requestId = Number((row as any)?.sourceId || 0);
                const requestStatus = requestId ? withdrawalRequestStatusMap.get(requestId) : '';
                const keepFrozen = ['PENDING_REVIEW', 'APPROVED', 'PAYING', 'PROCESSING'].includes(String(requestStatus || ''));

                if (!keepFrozen) {
                    return {
                        available,
                        earningFrozen,
                        withdrawFrozen,
                        deltaAvailable: 0,
                        deltaFrozen: 0,
                        ignored: true,
                        ignoredReason: 'WITHDRAW_RESERVE_SETTLED' as const,
                    };
                }

                available = r2(available - amount);
                withdrawFrozen = r2(withdrawFrozen + amount);
                return {
                    available,
                    earningFrozen,
                    withdrawFrozen,
                    deltaAvailable: r2(-amount),
                    deltaFrozen: r2(amount),
                    ignored: false as const,
                };
            }

            if (biz === 'WITHDRAW_RELEASE') {
                return {
                    available,
                    earningFrozen,
                    withdrawFrozen,
                    deltaAvailable: 0,
                    deltaFrozen: 0,
                    ignored: true,
                    ignoredReason: 'WITHDRAW_RELEASE_TERMINAL' as const,
                };
            }

            if (biz === 'WITHDRAW_PAYOUT') {
                available = r2(available - amount);
                return {
                    available,
                    earningFrozen,
                    withdrawFrozen,
                    deltaAvailable: r2(-amount),
                    deltaFrozen: 0,
                    ignored: false as const,
                };
            }

            if (biz === 'DEPOSIT_ADD') {
                // 押金划转：
                // - OUT：钱包可用转入押金，需扣减可用
                // - IN：押金余额增加记录，不应增加钱包可用
                if (direction === 'OUT') {
                    available = r2(available - amount);
                    return {
                        available,
                        earningFrozen,
                        withdrawFrozen,
                        deltaAvailable: r2(-amount),
                        deltaFrozen: 0,
                        ignored: false as const,
                    };
                }
                return {
                    available,
                    earningFrozen,
                    withdrawFrozen,
                    deltaAvailable: 0,
                    deltaFrozen: 0,
                    ignored: true,
                    ignoredReason: 'DEPOSIT_BUCKET_ONLY' as const,
                };
            }

            if (biz === 'DEPOSIT_REFUND') {
                available = r2(available + amount);
                return {
                    available,
                    earningFrozen,
                    withdrawFrozen,
                    deltaAvailable: r2(amount),
                    deltaFrozen: 0,
                    ignored: false as const,
                };
            }

            if (biz === 'DEPOSIT_DEDUCT') {
                available = r2(available - amount);
                return {
                    available,
                    earningFrozen,
                    withdrawFrozen,
                    deltaAvailable: r2(-amount),
                    deltaFrozen: 0,
                    ignored: false as const,
                };
            }

            if (biz === 'RELEASE_FROZEN') {
                const sourceId = Number((row as any)?.sourceId || 0);
                const source = sourceId ? releaseSourceStatusMap.get(sourceId) : null;
                if (replayMode === 'full' && source?.status === 'AVAILABLE') {
                    return {
                        available,
                        earningFrozen,
                        withdrawFrozen,
                        deltaAvailable: 0,
                        deltaFrozen: 0,
                        ignored: true,
                        ignoredReason: 'RELEASE_DUPLICATE_SOURCE_AVAILABLE' as const,
                    };
                }
                earningFrozen = r2(earningFrozen - amount);
                available = r2(available + amount);
                return {
                    available,
                    earningFrozen,
                    withdrawFrozen,
                    deltaAvailable: r2(amount),
                    deltaFrozen: r2(-amount),
                    ignored: false as const,
                };
            }

            const sign = direction === 'OUT' ? -1 : 1;

            if (status === 'FROZEN') {
                earningFrozen = r2(earningFrozen + sign * amount);
                return {
                    available,
                    earningFrozen,
                    withdrawFrozen,
                    deltaAvailable: 0,
                    deltaFrozen: r2(sign * amount),
                    ignored: false as const,
                };
            }

            if (status === 'AVAILABLE') {
                available = r2(available + sign * amount);
                return {
                    available,
                    earningFrozen,
                    withdrawFrozen,
                    deltaAvailable: r2(sign * amount),
                    deltaFrozen: 0,
                    ignored: false as const,
                };
            }

            // 未知状态：不动余额，只计入忽略
            return {
                available,
                earningFrozen,
                withdrawFrozen,
                deltaAvailable: 0,
                deltaFrozen: 0,
                ignored: true,
                ignoredReason: 'UNKNOWN_STATUS' as const,
            };
        };

        const where: any = { userId };
        if (params?.startAt || params?.endAt) {
            where.createdAt = {};
            if (params?.startAt) where.createdAt.gte = new Date(params.startAt);
            if (params?.endAt) where.createdAt.lte = new Date(params.endAt);
        }

        // 若传了 startAt，先回放 startAt 前流水，得到区间起始余额
        let openingAvailable = 0;
        let openingEarningFrozen = 0;
        let openingWithdrawFrozen = 0;
        let openingFrozen = 0;
        if (params?.startAt) {
            const beforeRows = await this.prisma.walletTransaction.findMany({
                where: {
                    userId,
                    createdAt: { lt: new Date(params.startAt) },
                },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: {
                    bizType: true,
                    status: true,
                    direction: true,
                    amount: true,
                    sourceId: true,
                },
            });

            releaseSourceStatusMap = await loadReleaseSourceStatusMap(beforeRows);
            withdrawalRequestStatusMap = await loadWithdrawalRequestStatusMap(beforeRows);

            for (const row of beforeRows) {
                const result = applyDelta({
                    ...(row as any),
                    available: openingAvailable,
                    earningFrozen: openingEarningFrozen,
                    withdrawFrozen: openingWithdrawFrozen,
                });
                openingAvailable = r2(result.available);
                openingEarningFrozen = r2(result.earningFrozen);
                openingWithdrawFrozen = r2(result.withdrawFrozen);
                openingFrozen = r2(openingEarningFrozen + openingWithdrawFrozen);
            }
        }

        const rows = await this.prisma.walletTransaction.findMany({
            where,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
                id: true,
                createdAt: true,
                bizType: true,
                status: true,
                direction: true,
                amount: true,
                sourceType: true,
                sourceId: true,
                orderId: true,
                dispatchId: true,
                settlementId: true,
                availableAfter: true,
                frozenAfter: true,
            },
        });

        const depositWalletTxCount = rows.filter((row: any) =>
            ['DEPOSIT_ADD', 'DEPOSIT_REFUND', 'DEPOSIT_DEDUCT', 'STAFF_EXIT_RELEASE', 'STAFF_EXIT_CLEAR'].includes(String(row?.bizType || '')),
        ).length;

        if (!params?.startAt) {
            releaseSourceStatusMap = await loadReleaseSourceStatusMap(rows as any);
            withdrawalRequestStatusMap = await loadWithdrawalRequestStatusMap(rows as any);
        } else {
            const rowMap = await loadReleaseSourceStatusMap(rows as any);
            for (const [key, value] of rowMap.entries()) {
                releaseSourceStatusMap.set(key, value);
            }
            const requestMap = await loadWithdrawalRequestStatusMap(rows as any);
            for (const [key, value] of requestMap.entries()) {
                withdrawalRequestStatusMap.set(key, value);
            }
        }

        let replayAvailable = openingAvailable;
        let replayEarningFrozen = openingEarningFrozen;
        let replayWithdrawFrozen = openingWithdrawFrozen;
        let replayFrozen = openingFrozen;
        let ignoredCount = 0;
        let negativeMoments = 0;
        const ignoredBizBreakdown: Record<string, number> = {};
        const bizBreakdown: Record<string, number> = {};
        const mismatchRows: any[] = [];
        const negativeRows: any[] = [];
        const replayRows: any[] = [];
        let replaySettlementTotal = 0;
        let historySettlementTotal = 0;
        let replayWithdrawalTotal = 0;
        let historyWithdrawalTotal = 0;
        let replaySettlementCount = 0;
        let historySettlementCount = 0;
        let replayWithdrawalCount = 0;
        let historyWithdrawalCount = 0;

        for (const row of rows) {
            const biz = String(row.bizType || 'UNKNOWN');
            bizBreakdown[biz] = (bizBreakdown[biz] || 0) + 1;

            const result = applyDelta({
                ...(row as any),
                available: replayAvailable,
                earningFrozen: replayEarningFrozen,
                withdrawFrozen: replayWithdrawFrozen,
            });
            if ((result as any).ignored) {
                ignoredCount++;
                ignoredBizBreakdown[biz] = (ignoredBizBreakdown[biz] || 0) + 1;
            }

            replayAvailable = r2(result.available);
            replayEarningFrozen = r2(result.earningFrozen);
            replayWithdrawFrozen = r2(result.withdrawFrozen);
            replayFrozen = r2(replayEarningFrozen + replayWithdrawFrozen);
            const replayTotalAfter = r2(replayAvailable + replayFrozen);

            if (replayAvailable < 0 || replayFrozen < 0) {
                negativeMoments++;
                if (negativeRows.length < mismatchLimit) {
                    negativeRows.push({
                        id: row.id,
                        createdAt: row.createdAt,
                        bizType: row.bizType,
                        status: row.status,
                        direction: row.direction,
                        amount: r2(row.amount),
                        sourceType: row.sourceType,
                        sourceId: row.sourceId,
                        orderId: row.orderId,
                        settlementId: row.settlementId,
                        dispatchId: row.dispatchId,
                        replayAvailableAfter: replayAvailable,
                        replayFrozenAfter: replayFrozen,
                    });
                }
            }

            // ===== 统计：结算收益（重放/历史）=====
            if (settlementBizSet.has(biz)) {
                const amt = r2(row.amount);
                const sign = row.direction === 'OUT' ? -1 : 1;

                // 历史：按流水现状统计（排除 REVERSED）
                if (row.status !== 'REVERSED') {
                    historySettlementTotal = r2(historySettlementTotal + sign * amt);
                    historySettlementCount += 1;
                }
                // 重放：按当前重放规则统计
                if (!(result as any).ignored) {
                    replaySettlementTotal = r2(replaySettlementTotal + sign * amt);
                    replaySettlementCount += 1;
                }
            }

            // ===== 统计：提现总和（重放/历史）=====
            if (biz === 'WITHDRAW_PAYOUT') {
                const amt = r2(row.amount);
                // 历史提现：排除 REVERSED，记为正向“提现总额”
                if (row.status !== 'REVERSED') {
                    historyWithdrawalTotal = r2(historyWithdrawalTotal + amt);
                    historyWithdrawalCount += 1;
                }
                if (!(result as any).ignored) {
                    replayWithdrawalTotal = r2(replayWithdrawalTotal + amt);
                    replayWithdrawalCount += 1;
                }
            }

            const sa = row.availableAfter === null || row.availableAfter === undefined ? null : r2(row.availableAfter);
            const sf = row.frozenAfter === null || row.frozenAfter === undefined ? null : r2(row.frozenAfter);
            if (sa !== null && sf !== null) {
                const da = r2(replayAvailable - sa);
                const df = r2(replayFrozen - sf);
                if (Math.abs(da) > 0.009 || Math.abs(df) > 0.009) {
                    if (mismatchRows.length < mismatchLimit) {
                        mismatchRows.push({
                            id: row.id,
                            createdAt: row.createdAt,
                            bizType: row.bizType,
                            status: row.status,
                            direction: row.direction,
                            amount: r2(row.amount),
                            sourceType: row.sourceType,
                            sourceId: row.sourceId,
                            orderId: row.orderId,
                            settlementId: row.settlementId,
                            dispatchId: row.dispatchId,
                            storedAvailableAfter: sa,
                            storedFrozenAfter: sf,
                            replayAvailableAfter: replayAvailable,
                            replayFrozenAfter: replayFrozen,
                            deltaAvailable: da,
                            deltaFrozen: df,
                        });
                    }
                }
            }

            replayRows.push({
                id: row.id,
                createdAt: row.createdAt,
                bizType: row.bizType,
                status: row.status,
                direction: row.direction,
                amount: r2(row.amount),
                sourceType: row.sourceType,
                sourceId: row.sourceId,
                orderId: row.orderId,
                settlementId: row.settlementId,
                dispatchId: row.dispatchId,
                replayAvailableAfter: replayAvailable,
                replayFrozenAfter: replayFrozen,
                replayTotalAfter,
                ignored: Boolean((result as any).ignored),
                ignoredReason: (result as any).ignoredReason || null,
            });
        }

        const accountNow = await this.prisma.walletAccount.findUnique({
            where: { userId },
            select: { availableBalance: true, frozenBalance: true, depositBalance: true },
        });

        const currentAvailable = r2(accountNow?.availableBalance);
        const currentFrozen = r2(accountNow?.frozenBalance);
        const currentTotal = r2(currentAvailable + currentFrozen);
        const currentDepositBalance = r2((accountNow as any)?.depositBalance ?? 0);
        const depositCompatibilityDeduction =
            replayMode === 'full' && currentDepositBalance > 0 && depositWalletTxCount === 0
                ? currentDepositBalance
                : 0;

        if (depositCompatibilityDeduction > 0) {
            replayAvailable = r2(replayAvailable - depositCompatibilityDeduction);
            replayFrozen = r2(replayEarningFrozen + replayWithdrawFrozen);
        }

        const replayTotal = r2(replayAvailable + replayFrozen);

        const diffAvailable = r2(replayAvailable - currentAvailable);
        const diffFrozen = r2(replayFrozen - currentFrozen);
        const diffTotal = r2(replayTotal - currentTotal);
        const settlementDiff = r2(replaySettlementTotal - historySettlementTotal);
        const withdrawalDiff = r2(replayWithdrawalTotal - historyWithdrawalTotal);

        return {
            userId,
            mode: replayMode,
            range: {
                startAt: params?.startAt ?? null,
                endAt: params?.endAt ?? null,
            },
            openingBalance: {
                available: openingAvailable,
                frozen: openingFrozen,
                total: r2(openingAvailable + openingFrozen),
            },
            currentBalance: {
                available: currentAvailable,
                frozen: currentFrozen,
                total: currentTotal,
            },
            replayBalance: {
                available: replayAvailable,
                frozen: replayFrozen,
                total: replayTotal,
            },
            replayBuckets: {
                available: replayAvailable,
                earningFrozen: replayEarningFrozen,
                withdrawFrozen: replayWithdrawFrozen,
                frozen: replayFrozen,
                total: replayTotal,
            },
            diff: {
                available: diffAvailable,
                frozen: diffFrozen,
                total: diffTotal,
            },
            settlementSummary: {
                replayTotal: replaySettlementTotal,
                historyTotal: historySettlementTotal,
                replayCount: replaySettlementCount,
                historyCount: historySettlementCount,
                diff: settlementDiff, // 负数=历史多结算；正数=历史少结算
                signRule: 'diff = replay - history; diff < 0 表示历史多结算，diff > 0 表示历史少结算',
            },
            withdrawalSummary: {
                replayTotal: replayWithdrawalTotal,
                historyTotal: historyWithdrawalTotal,
                replayCount: replayWithdrawalCount,
                historyCount: historyWithdrawalCount,
                diff: withdrawalDiff, // 负数=历史提现记账更多；正数=历史提现记账更少
                signRule: 'diff = replay - history',
            },
            stats: {
                txCount: rows.length,
                ignoredCount,
                mismatchCount: mismatchRows.length,
                negativeMoments,
                ignoredBizBreakdown,
                bizBreakdown,
                noBalanceBizTypes: Array.from(noBalanceBizSet),
            },
            replayAdjustments: {
                depositCompatibilityDeduction,
                currentDepositBalance,
                depositWalletTxCount,
            },
            replayRows,
            mismatchRows,
            negativeRows,
        };
    }

    /** ✅ 截断到 1 位小数（不四舍五入） */
    private trunc1(v: any): number {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;

        // 1位：乘10后截断再除10
        // 注意：Math.trunc 对负数也是“向0截断”，符合“舍弃”直觉
        return Math.trunc(n * 10) / 10;
    }


    // wallet.service.ts

    async getTransactionsByUserId(params: {
        userId: number;
        startAt?: string;
        endAt?: string;
        page: number;
        pageSize: number;
    }) {
        const { userId, startAt, endAt, page, pageSize } = params;

        const where: any = { userId };

        if (startAt && endAt) {
            where.createdAt = {
                gte: new Date(startAt),
                lte: new Date(endAt),
            };
        }

        const [data, total] = await this.prisma.$transaction([
            this.prisma.walletTransaction.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            this.prisma.walletTransaction.count({ where }),
        ]);

        return { data, total };
    }


    /**
     * 将“单个结算收益”写入钱包（流水/冻结/余额/快照）
     * - 前置：OrderSettlement 已经创建好，拿到了 settlementId
     * - 幂等：sourceType+sourceId（sourceId=settlementId）
     * - 正向收益：默认冻结（FROZEN + WalletHold），到期由 releaseDueHoldsOnce 解冻
     * - 负向收益：直接扣 available（OUT + AVAILABLE），不冻结
     */
    async applySettlementEarningToWalletV1(params: {
        tx: any;

        userId: number;
        settlementId: number;

        orderId?: number | null;
        dispatchId?: number | null;

        finalEarnings: number;

        unlockAt: Date;

        freezeWhenPositive?: boolean;
    })
    {
        const {
            tx,
            userId,
            settlementId,
            orderId = null,
            dispatchId = null,
            finalEarnings,
            unlockAt,
            freezeWhenPositive = true,
        } = params;

        // 保持你原逻辑：先确保账户存在（即使 finalEarnings=0 也会创建账户）
        await this.ensureWalletAccount(userId, tx as any);

        const amountAbs = round2(Math.abs(Number(finalEarnings ?? 0)));
        if (!Number.isFinite(amountAbs)) throw new BadRequestException('finalEarnings 非法');

        if (amountAbs === 0) {
            return { skipped: true, reason: 'finalEarnings=0' };
        }

        const isPositive = Number(finalEarnings) > 0;
        const direction = isPositive ? 'IN' : 'OUT';
        const bizType = isPositive ? 'SETTLEMENT_EARNING_BASE' : 'SETTLEMENT_BOMB_LOSS';

        const now = new Date();
        const shouldFreeze =
            isPositive &&
            freezeWhenPositive === true &&
            unlockAt &&
            new Date(unlockAt).getTime() > now.getTime();

        // ======================================================
        // ✅ 幂等（第一层）：按“来源唯一键”查重
        // DB 优化：findFirst -> findUnique（命中 uniq_wallet_tx_source）
        // 同时缩小 select 字段，减少 IO
        // ======================================================
        const existedBySource = await tx.walletTransaction.findUnique({
            // ⚠️ 这里的 where 输入名以 Prisma 生成的为准
            where: {
                sourceType_sourceId: {
                    sourceType: 'ORDER_SETTLEMENT',
                    sourceId: settlementId,
                },
            } as any,
            select: {
                id: true,
                userId: true,
                bizType: true,
                direction: true,
                amount: true,
                status: true,
            },
        });

        if (existedBySource) {
            if (Number(existedBySource.userId) !== Number(userId)) {
                throw new BadRequestException(
                    `发现同来源钱包流水但 userId 不一致，需人工处理：` +
                    `settlementId=${settlementId}, newUserId=${userId}, existedTxId=${existedBySource.id}, existedUserId=${existedBySource.userId}`,
                );
            }

            const existedAmount = round2(Number(existedBySource.amount ?? 0));
            const sameAmount = Number(existedAmount) === Number(amountAbs);
            const sameDirection = String(existedBySource.direction) === String(direction);
            const sameBizType = String(existedBySource.bizType) === String(bizType);

            if (sameAmount && sameDirection && sameBizType) {
                return {
                    reused: true,
                    earningTxId: existedBySource.id,
                    shouldFreeze: existedBySource.status === 'FROZEN',
                    amount: amountAbs,
                    direction,
                    note: '已存在同来源钱包流水（uniq_wallet_tx_source），本次跳过创建与余额更新',
                };
            }

            throw new BadRequestException(
                `同来源钱包流水已存在但内容不一致，需人工冲正/重建：` +
                `settlementId=${settlementId}, userId=${userId}, existedTxId=${existedBySource.id}, ` +
                `existedBizType=${existedBySource.bizType}, newBizType=${bizType}, ` +
                `existedDirection=${existedBySource.direction}, newDirection=${direction}, ` +
                `existedAmount=${existedAmount}, newAmount=${amountAbs}`,
            );
        }

        // ======================================================
        // ✅ 创建收益流水（第二层）：并发兜底 P2002
        // DB 优化：catch P2002 后回读也用 findUnique（走唯一键）
        // ======================================================
        let earningTx: { id: number };
        try {
            earningTx = await tx.walletTransaction.create({
                data: {
                    userId,
                    direction,
                    bizType,
                    amount: amountAbs,
                    status: shouldFreeze ? 'FROZEN' : 'AVAILABLE',

                    sourceType: 'ORDER_SETTLEMENT',
                    sourceId: settlementId,

                    orderId,
                    dispatchId,
                    settlementId,
                } as any,
                select: { id: true },
            });
        } catch (e: any) {
            if (e?.code === 'P2002') {
                const existed = await tx.walletTransaction.findUnique({
                    where: {
                        sourceType_sourceId: {
                            sourceType: 'ORDER_SETTLEMENT',
                            sourceId: settlementId,
                        },
                    } as any,
                    select: {
                        id: true,
                        userId: true,
                        bizType: true,
                        direction: true,
                        amount: true,
                        status: true,
                    },
                });

                if (existed) {
                    if (Number(existed.userId) !== Number(userId)) {
                        throw new BadRequestException(
                            `钱包流水来源冲突且 userId 不一致，需人工处理：settlementId=${settlementId}, newUserId=${userId}, existedTxId=${existed.id}, existedUserId=${existed.userId}`,
                        );
                    }

                    const existedAmount = round2(Number(existed.amount ?? 0));
                    const sameAmount = Number(existedAmount) === Number(amountAbs);
                    const sameDirection = String(existed.direction) === String(direction);
                    const sameBizType = String(existed.bizType) === String(bizType);

                    if (sameAmount && sameDirection && sameBizType) {
                        return {
                            reused: true,
                            earningTxId: existed.id,
                            shouldFreeze: existed.status === 'FROZEN',
                            amount: amountAbs,
                            direction,
                            note: 'create 触发 uniq_wallet_tx_source，已回读复用现存流水',
                        };
                    }

                    throw new BadRequestException(
                        `create 冲突回读到的流水与本次不一致，需人工冲正/重建：` +
                        `settlementId=${settlementId}, userId=${userId}, existedTxId=${existed.id}, ` +
                        `existedBizType=${existed.bizType}, newBizType=${bizType}, ` +
                        `existedDirection=${existed.direction}, newDirection=${direction}, ` +
                        `existedAmount=${existedAmount}, newAmount=${amountAbs}`,
                    );
                }
            }

            throw e;
        }

        // 2) 更新账户余额（逻辑不动）
        let accountAfter: any;

        if (direction === 'OUT') {
            accountAfter = await this.applyWalletAccountDelta(tx as any, userId, {
                availableDelta: -amountAbs,
            });
        } else if (shouldFreeze) {
            accountAfter = await this.applyWalletAccountDelta(tx as any, userId, {
                earningFrozenDelta: amountAbs,
            });
        } else {
            accountAfter = await this.applyWalletAccountDelta(tx as any, userId, {
                availableDelta: amountAbs,
            });
        }

        // 3) 回写余额快照到 earningTx（逻辑不动）
        await tx.walletTransaction.update({
            where: { id: earningTx.id },
            data: {
                availableAfter: round2(Number(accountAfter?.availableBalance ?? 0)),
                frozenAfter: round2(Number(accountAfter?.frozenBalance ?? 0)),
            } as any,
        });

        // 4) 若需要冻结：创建 hold（逻辑不动）
        let hold: any = null;
        if (shouldFreeze) {
            hold = await tx.walletHold.create({
                data: {
                    userId,
                    earningTxId: earningTx.id,
                    amount: amountAbs,
                    status: 'FROZEN',
                    unlockAt: new Date(unlockAt),
                } as any,
                select: { id: true, unlockAt: true, status: true },
            });
        }

        return {
            earningTxId: earningTx.id,
            hold,
            shouldFreeze,
            amount: amountAbs,
            direction,
        };
    }

    async applySettlementEarningToWalletV2(params: {
        tx: any;

        userId: number;
        settlementId?: number | null;

        orderId?: number | null;
        dispatchId?: number | null;

        finalEarnings: number;

        unlockAt?: Date | null;

        freezeWhenPositive?: boolean;
        /** 可选：强制新流水状态，避免重算/冲正时把冻结态误落到可用余额 */
        statusHint?: 'FROZEN' | 'AVAILABLE' | null;

        /** 可选：覆盖业务类型（如 SETTLEMENT_RECALC / SETTLEMENT_REVERSAL） */
        bizTypeOverride?: string | null;

        /** 可选：覆盖来源类型（默认 ORDER_SETTLEMENT） */
        sourceTypeOverride?: string | null;

        /** 可选：覆盖来源ID（默认 settlementId） */
        sourceIdOverride?: number | null;
    }) {
        const {
            tx,
            userId,
            settlementId = null,
            orderId = null,
            dispatchId = null,
            finalEarnings,
            unlockAt = null,
            freezeWhenPositive = true,
            statusHint = null,
            bizTypeOverride = null,
            sourceTypeOverride = null,
            sourceIdOverride = null,
        } = params;

        await this.ensureWalletAccount(userId, tx as any);

        const amountAbs = round2(Math.abs(Number(finalEarnings ?? 0)));
        if (!Number.isFinite(amountAbs)) {
            throw new BadRequestException('finalEarnings 非法');
        }

        if (amountAbs === 0) {
            return { skipped: true, reason: 'finalEarnings=0' };
        }

        const isPositive = Number(finalEarnings) > 0;
        const direction = isPositive ? 'IN' : 'OUT';

        const bizType =
            bizTypeOverride ??
            (isPositive ? 'SETTLEMENT_EARNING_BASE' : 'SETTLEMENT_BOMB_LOSS');

        const sourceType = String(sourceTypeOverride ?? 'ORDER_SETTLEMENT');
        const sourceId = Number(sourceIdOverride ?? settlementId ?? 0);

        if (!sourceType || !sourceId) {
            throw new BadRequestException(
                `钱包流水来源缺失：sourceType=${sourceType}, sourceId=${sourceId}`,
            );
        }

        const now = new Date();
        const shouldFreeze =
            isPositive &&
            freezeWhenPositive === true &&
            unlockAt &&
            new Date(unlockAt).getTime() > now.getTime() &&
            statusHint !== 'AVAILABLE';

        const targetStatus: WalletTxStatus = (() => {
            if (isPositive) {
                if (statusHint === 'FROZEN') return 'FROZEN';
                if (statusHint === 'AVAILABLE') return 'AVAILABLE';
                return shouldFreeze ? 'FROZEN' : 'AVAILABLE';
            }

            if (statusHint === 'FROZEN') return 'FROZEN';
            return 'AVAILABLE';
        })();

        // ======================================================
        // ✅ 幂等（第一层）：按 sourceType + sourceId 查重
        // ======================================================
        const existedBySource = await tx.walletTransaction.findUnique({
            where: {
                sourceType_sourceId: {
                    sourceType,
                    sourceId,
                },
            } as any,
            select: {
                id: true,
                userId: true,
                bizType: true,
                direction: true,
                amount: true,
                status: true,
            },
        });

        const existingHold = existedBySource
            ? await tx.walletHold.findUnique({
                where: { earningTxId: existedBySource.id },
                select: { id: true, amount: true, status: true, unlockAt: true },
            })
            : null;

        const signedAmount = direction === 'IN' ? amountAbs : -amountAbs;
        const effectForStatus = (status: WalletTxStatus) => ({
            available: status === 'AVAILABLE' ? signedAmount : 0,
            frozen: status === 'FROZEN' ? signedAmount : 0,
        });

        const resolveUnlockAt = () => {
            const resolved = unlockAt ?? existingHold?.unlockAt ?? null;
            if (!resolved) {
                throw new BadRequestException('缺少 unlockAt：首次创建冻结收益时必须提供解冻时间');
            }
            return new Date(resolved as any);
        };

        const applyAccountDelta = async (availableDelta: number, earningFrozenDelta: number) => {
            return this.applyWalletAccountDelta(tx as any, userId, {
                availableDelta,
                earningFrozenDelta,
            });
        };

        const syncHold = async (earningTxId: number, status: WalletTxStatus) => {
            if (status === 'FROZEN') {
                const resolvedUnlockAt = resolveUnlockAt();
                return tx.walletHold.upsert({
                    where: { earningTxId },
                    create: {
                        userId,
                        earningTxId,
                        amount: amountAbs,
                        status: 'FROZEN',
                        unlockAt: resolvedUnlockAt,
                    } as any,
                    update: {
                        userId,
                        amount: amountAbs,
                        status: 'FROZEN',
                        unlockAt: resolvedUnlockAt,
                        releasedAt: null,
                    } as any,
                    select: { id: true, unlockAt: true, status: true },
                });
            }

            if (existingHold) {
                await tx.walletHold.delete({
                    where: { id: existingHold.id },
                });
            }

            return null;
        };

        let earningTxId: number;
        let accountAfter: any;
        let hold: any = null;

        if (existedBySource) {
            if (Number(existedBySource.userId) !== Number(userId)) {
                throw new BadRequestException(
                    `发现同来源钱包流水但 userId 不一致，需人工处理：` +
                    `sourceType=${sourceType}, sourceId=${sourceId}, newUserId=${userId}, ` +
                    `existedTxId=${existedBySource.id}, existedUserId=${existedBySource.userId}`,
                );
            }

            const sameAmount = Number(round2(Number(existedBySource.amount ?? 0))) === Number(amountAbs);
            const sameDirection = String(existedBySource.direction) === String(direction);
            const sameBizType = String(existedBySource.bizType) === String(bizType);

            if (!sameAmount || !sameDirection || !sameBizType) {
                throw new BadRequestException(
                    `同来源钱包流水已存在但内容不一致，需人工冲正/重建：` +
                    `sourceType=${sourceType}, sourceId=${sourceId}, userId=${userId}, existedTxId=${existedBySource.id}, ` +
                    `existedBizType=${existedBySource.bizType}, newBizType=${bizType}, ` +
                    `existedDirection=${existedBySource.direction}, newDirection=${direction}, ` +
                    `existedAmount=${round2(Number(existedBySource.amount ?? 0))}, newAmount=${amountAbs}`,
                );
            }

            earningTxId = existedBySource.id;

            if (String(existedBySource.status) === String(targetStatus)) {
                hold = await syncHold(earningTxId, targetStatus);

                return {
                    reused: true,
                    earningTxId,
                    hold,
                    shouldFreeze: targetStatus === 'FROZEN',
                    amount: amountAbs,
                    direction,
                    status: targetStatus,
                    bizType,
                    sourceType,
                    sourceId,
                    note: '已存在同来源钱包流水（uniq_wallet_tx_source），本次跳过余额更新，仅校正冻结单状态',
                };
            }

            const existedEffect = effectForStatus(existedBySource.status as WalletTxStatus);
            const targetEffect = effectForStatus(targetStatus);
            const availableDelta = round2(targetEffect.available - existedEffect.available);
            const frozenDelta = round2(targetEffect.frozen - existedEffect.frozen);

            await tx.walletTransaction.update({
                where: { id: earningTxId },
                data: {
                    userId,
                    direction,
                    bizType,
                    amount: amountAbs,
                    status: targetStatus,
                    orderId,
                    dispatchId,
                    settlementId,
                } as any,
            });

            accountAfter = await applyAccountDelta(availableDelta, frozenDelta);
            await tx.walletTransaction.update({
                where: { id: earningTxId },
                data: {
                    availableAfter: round2(Number(accountAfter?.availableBalance ?? 0)),
                    frozenAfter: round2(Number(accountAfter?.frozenBalance ?? 0)),
                } as any,
            });

            hold = await syncHold(earningTxId, targetStatus);
        } else {
            const earningTx = await tx.walletTransaction.create({
                data: {
                    userId,
                    direction,
                    bizType,
                    amount: amountAbs,
                    status: targetStatus,
                    sourceType,
                    sourceId,
                    orderId,
                    dispatchId,
                    settlementId,
                } as any,
                select: { id: true },
            });

            earningTxId = earningTx.id;

            const targetEffect = effectForStatus(targetStatus);
            accountAfter = await applyAccountDelta(targetEffect.available, targetEffect.frozen);

            await tx.walletTransaction.update({
                where: { id: earningTxId },
                data: {
                    availableAfter: round2(Number(accountAfter?.availableBalance ?? 0)),
                    frozenAfter: round2(Number(accountAfter?.frozenBalance ?? 0)),
                } as any,
            });

            hold = await syncHold(earningTxId, targetStatus);
        }

        return {
            earningTxId,
            hold,
            shouldFreeze: targetStatus === 'FROZEN',
            amount: amountAbs,
            direction,
            status: targetStatus,
            bizType,
            sourceType,
            sourceId,
        };
    }


    /**
     * 修复专用 V2：不直接回滚 WalletAccount
     * - 只识别“结算主流水” + “对应 releaseTx”
     * - 生成 reversalPlans（冲正计划），由外层统一写入 SETTLEMENT_REVERSAL 流水
     * - 旧流水保留，不删除
     */
    // async rollbackOrderWalletImpactInTxV2(params: {
    //     tx: any;
    //     settlementIds: number[]; // 该订单下所有 OrderSettlement.id
    // })
    // {
    //     const { tx, settlementIds } = params;
    //
    //     const ids = Array.from(new Set((settlementIds || []).filter(Boolean)));
    //     if (ids.length === 0) {
    //         return {
    //             affectedUsers: 0,
    //             txCount: 0,
    //             releaseTxCount: 0,
    //             earningTxIds: [] as number[],
    //             releaseTxIds: [] as number[],
    //             reversalPlans: [] as any[],
    //         };
    //     }
    //
    //     // 1) 只取“结算主流水”
    //     //    ⚠️ 不再按 settlementId 扫全部流水，避免把 releaseTx / 其他衍生流水重复算进去
    //     const baseTxs = await tx.walletTransaction.findMany({
    //         where: {
    //             sourceType: 'ORDER_SETTLEMENT',
    //             sourceId: { in: ids },
    //             NOT: { status: 'REVERSED' },
    //         },
    //         select: {
    //             id: true,
    //             userId: true,
    //             direction: true, // IN/OUT
    //             status: true,    // FROZEN/AVAILABLE
    //             amount: true,
    //             sourceId: true,  // settlementId
    //             settlementId: true,
    //             orderId: true,
    //             dispatchId: true,
    //             bizType: true,
    //         },
    //     });
    //
    //     const earningTxIds = baseTxs.map((t: any) => Number(t.id)).filter(Boolean);
    //
    //     // 2) 对应 releaseTx（sourceId = earningTxId）
    //     let releaseTxs: any[] = [];
    //     if (earningTxIds.length > 0) {
    //         releaseTxs = await tx.walletTransaction.findMany({
    //             where: {
    //                 sourceType: 'WALLET_HOLD_RELEASE',
    //                 sourceId: { in: earningTxIds },
    //                 NOT: { status: 'REVERSED' },
    //             },
    //             select: {
    //                 id: true,
    //                 userId: true,
    //                 direction: true,
    //                 status: true,
    //                 amount: true,
    //                 sourceId: true, // earningTxId
    //                 bizType: true,
    //             },
    //         });
    //     }
    //
    //     const releaseTxMap = new Map<number, any[]>();
    //     for (const r of releaseTxs) {
    //         const earningTxId = Number(r.sourceId ?? 0);
    //         if (!earningTxId) continue;
    //         const arr = releaseTxMap.get(earningTxId) ?? [];
    //         arr.push(r);
    //         releaseTxMap.set(earningTxId, arr);
    //     }
    //
    //     const reversalPlans: any[] = [];
    //
    //     // 3.1 主收益流水 reversal plan
    //     for (const t of baseTxs) {
    //         const userId = Number(t.userId ?? 0);
    //         const amount = round2(Number(t.amount ?? 0));
    //         if (!userId || !amount) continue;
    //
    //         const originalDirection = String(t.direction);
    //         const reversalDirection = originalDirection === 'OUT' ? 'IN' : 'OUT';
    //
    //         reversalPlans.push({
    //             kind: 'EARNING_TX_REVERSAL',
    //
    //             userId,
    //             orderId: t.orderId ?? null,
    //             dispatchId: t.dispatchId ?? null,
    //             settlementId: t.settlementId ?? null,
    //
    //             sourceTxId: t.id,
    //             sourceSettlementId: Number(t.sourceId ?? t.settlementId ?? 0),
    //
    //             finalEarnings: reversalDirection === 'IN' ? amount : -amount,
    //             amount,
    //
    //             direction: reversalDirection,
    //             statusHint: t.status, // 原流水是 FROZEN / AVAILABLE
    //             bizType: 'SETTLEMENT_REVERSAL',
    //
    //             sourceTypeOverride: 'ORDER_SETTLEMENT_REVERSAL',
    //             sourceIdOverride: Number(t.id),
    //
    //             note: `冲正旧结算主流水 txId=${t.id}`,
    //         });
    //     }
    //
    //     // 3.2 releaseTx reversal plan
    //     // release 本质是 frozen -> available 的内部迁移
    //     // 修复时需要反向做一笔 AVAILABLE 反向流水，抵消 release 对 available 的影响
    //     for (const r of releaseTxs) {
    //         const userId = Number(r.userId ?? 0);
    //         const amount = round2(Number(r.amount ?? 0));
    //         if (!userId || !amount) continue;
    //
    //         const originalDirection = String(r.direction);
    //         const reversalDirection = originalDirection === 'OUT' ? 'IN' : 'OUT';
    //
    //         reversalPlans.push({
    //             kind: 'RELEASE_TX_REVERSAL',
    //
    //             userId,
    //             orderId: null,
    //             dispatchId: null,
    //             settlementId: null,
    //
    //             sourceTxId: r.id,
    //             sourceSettlementId: null,
    //
    //             finalEarnings: reversalDirection === 'IN' ? amount : -amount,
    //             amount,
    //
    //             direction: reversalDirection,
    //             statusHint: 'AVAILABLE', // release 影响的是 available
    //             bizType: 'SETTLEMENT_REVERSAL',
    //
    //             sourceTypeOverride: 'WALLET_HOLD_RELEASE_REVERSAL',
    //             sourceIdOverride: Number(r.id),
    //
    //             note: `冲正旧解冻流水 txId=${r.id}, earningTxId=${r.sourceId}`,
    //         });
    //     }
    //
    //     // 4) 统计信息（仅返回计划，不直接改余额）
    //     const affectedUserIdSet = new Set<number>(
    //         reversalPlans.map((p: any) => Number(p.userId)).filter(Boolean),
    //     );
    //
    //     return {
    //         affectedUsers: affectedUserIdSet.size,
    //         txCount: baseTxs.length,
    //         releaseTxCount: releaseTxs.length,
    //         earningTxIds,
    //         releaseTxIds: releaseTxs.map((t: any) => t.id),
    //         reversalPlans,
    //     };
    // }

    async rollbackOrderWalletImpactInTxV2(params: {
        tx: any;
        settlementIds: number[];
        orderId?: number | null;
    }) {
        const { tx, settlementIds, orderId } = params;

        const ids = Array.from(new Set((settlementIds || []).map(Number).filter(Boolean)));
        const oid = Number(orderId ?? 0);

        if (ids.length === 0) {
            return {
                affectedUsers: 0,
                txCount: 0,
                releaseTxCount: 0,
                earningTxIds: [] as number[],
                releaseTxIds: [] as number[],
                reversalPlans: [] as any[],
            };
        }

        // ✅ 只认真正“结算主流水”的 bizType
        const MAIN_SETTLEMENT_BIZ_TYPES = [
            'SETTLEMENT_EARNING',
            'SETTLEMENT_EARNING_BASE',
            'SETTLEMENT_EARNING_CARRY',
            'SETTLEMENT_BOMB_LOSS',
            'SETTLEMENT_EARNING_CS',
            'SETTLEMENT_RECALC',
        ];

        /**
         * Step 1：只取“结算主流水”
         * - sourceType 必须是 ORDER_SETTLEMENT / ORDER_SETTLEMENT_RECALC
         * - bizType 必须是主收益白名单
         * - 排除已经 REVERSED 的流水
         *
         * 目的：
         * - 不把 release / reversal / recalc / rollback 之类混进主流水集合
         */
        const baseTxs = await tx.walletTransaction.findMany({
            where: {
                sourceType: {
                    in: ['ORDER_SETTLEMENT', 'ORDER_SETTLEMENT_RECALC'],
                },
                ...(oid > 0 ? { orderId: oid } : { sourceId: { in: ids } }),
                bizType: { in: MAIN_SETTLEMENT_BIZ_TYPES },
                NOT: { status: 'REVERSED' },
            },
            select: {
                id: true,
                userId: true,
                direction: true,
                status: true, // FROZEN / AVAILABLE
                amount: true,
                sourceId: true, // settlementId
                settlementId: true,
                orderId: true,
                dispatchId: true,
                bizType: true,
            },
        });

        const earningTxIds = baseTxs.map((t: any) => Number(t.id)).filter(Boolean);

        /**
         * Step 2：查这些主流水对应的 releaseTx
         * - sourceType = WALLET_HOLD_RELEASE
         * - sourceId   = earningTxId
         * - bizType    = RELEASE_FROZEN
         */
        let releaseTxs: any[] = [];
        if (earningTxIds.length > 0) {
            releaseTxs = await tx.walletTransaction.findMany({
                where: {
                    sourceType: 'WALLET_HOLD_RELEASE',
                    sourceId: { in: earningTxIds },
                    bizType: 'RELEASE_FROZEN',
                    NOT: { status: 'REVERSED' },
                },
                select: {
                    id: true,
                    userId: true,
                    direction: true,
                    status: true,
                    amount: true,
                    sourceId: true, // earningTxId
                    bizType: true,
                },
            });
        }

        /**
         * releaseTxMap:
         * key   = earningTxId
         * value = 对应的 releaseTx 列表
         */
        const releaseTxMap = new Map<number, any[]>();
        for (const r of releaseTxs) {
            const earningTxId = Number(r.sourceId ?? 0);
            if (!earningTxId) continue;
            const arr = releaseTxMap.get(earningTxId) ?? [];
            arr.push(r);
            releaseTxMap.set(earningTxId, arr);
        }

        const reversalPlans: any[] = [];
        const sourceSettlementStatusHints: Array<{ settlementId: number; statusHint: 'FROZEN' | 'AVAILABLE' }> = [];

        /**
         * Step 3：每笔旧收益只生成一条 reversal plan
         *
         * 回滚重算的目标是撤销“当前仍在账户上的余额影响”，不是重演完整冻结/解冻生命周期。
         * 因此规则必须按旧收益当前落在哪个余额桶来决定：
         * - 已存在 releaseTx：说明这笔收益已经进 available，只冲 available
         * - 不存在 releaseTx：仍按原主流水当前状态处理（通常是 FROZEN）
         */
        for (const t of baseTxs) {
            const userId = Number(t.userId ?? 0);
            const amount = round2(Number(t.amount ?? 0));
            if (!userId || !amount) continue;

            const originalDirection = String(t.direction);
            const reversalDirection = originalDirection === 'OUT' ? 'IN' : 'OUT';

            const relatedReleaseTxs = releaseTxMap.get(Number(t.id)) ?? [];
            const hasRelease = relatedReleaseTxs.length > 0;

            const currentStatusHint =
                hasRelease || String(t.status) === 'AVAILABLE' ? 'AVAILABLE' : 'FROZEN';

            if (Number(t.sourceId ?? 0) > 0) {
                sourceSettlementStatusHints.push({
                    settlementId: Number(t.sourceId ?? t.settlementId ?? 0),
                    statusHint: currentStatusHint,
                });
            }

            reversalPlans.push({
                kind: 'EARNING_TX_REVERSAL',

                userId,
                orderId: t.orderId ?? null,
                dispatchId: t.dispatchId ?? null,
                settlementId: t.settlementId ?? null,

                sourceTxId: Number(t.id),
                sourceSettlementId: Number(t.sourceId ?? t.settlementId ?? 0),

                finalEarnings: reversalDirection === 'IN' ? amount : -amount,
                amount,
                direction: reversalDirection,

                statusHint: currentStatusHint,
                bizType: 'SETTLEMENT_REVERSAL',

                sourceTypeOverride: 'ORDER_SETTLEMENT_REVERSAL',
                sourceIdOverride: Number(t.id),

                note: `冲正旧结算主流水 txId=${t.id}, bizType=${t.bizType}, currentStatus=${currentStatusHint}, hasRelease=${hasRelease}`,
            });
        }

        const affectedUserIdSet = new Set<number>(
            reversalPlans.map((p: any) => Number(p.userId)).filter(Boolean),
        );

        return {
            affectedUsers: affectedUserIdSet.size,
            txCount: baseTxs.length,
            releaseTxCount: releaseTxs.length,
            earningTxIds,
            releaseTxIds: releaseTxs.map((t: any) => Number(t.id)),
            reversalPlans,
            sourceSettlementStatusHints,
        };
    }



    async uploadWithdrawQrCodeOnce(params: { userId: number; file: any }) {
        const { userId, file } = params;
        if (!userId) throw new BadRequestException('userId 非法');
        if (!file) throw new BadRequestException('请上传收款二维码');

        if (!file.mimetype?.startsWith('image/')) {
            throw new BadRequestException('仅支持图片格式');
        }

        // 1) 查询是否已上传（已上传则拒绝）
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { withdrawQrCodeKey: true },
        });

        if (user?.withdrawQrCodeKey) {
            throw new BadRequestException('收款二维码已上传，不支持修改');
        }

        // 2) 固定 key（对象路径）
        const cloudPath = `withdraw/qr-codes/u_${userId}.webp`;

        // 3) 上传到 CloudBase（返回 cloudObjectId / downloadUrl）
        const uploadRes = await tcbUploadFile({
            cloudPath,
            fileContent: file.buffer,
        });

        // ✅ 关键：落库存 cloudObjectId（用于 get-objects-download-info）
        const cloudObjectId = (uploadRes as any)?.cloudObjectId;
        if (!cloudObjectId) {
            throw new BadRequestException('上传成功但缺少 cloudObjectId（无法生成临时访问链接）');
        }

        await this.prisma.user.update({
            where: { id: userId },
            data: {
                withdrawQrCodeKey: cloudObjectId,
                withdrawQrCodeUploadedAt: new Date(),
            },
        });

        return { success: true };
    }


    async getWithdrawQrCodeUrl(params: { userId: number }) {
        const { userId } = params;
        if (!userId) throw new BadRequestException('userId 非法');

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { withdrawQrCodeKey: true },
        });

        const cloudObjectId = user?.withdrawQrCodeKey;
        if (!cloudObjectId) {
            return { url: null };
        }

        // ✅ 关键：这里传 cloudObjectId，而不是路径
        const url = await tcbGetTempFileURL({
            cloudPath: cloudObjectId, // 注意：虽然参数名叫 cloudPath，但实际传 cloudObjectId
            maxAgeSeconds: 600,
        });

        return { url: url || null };
    }


}
