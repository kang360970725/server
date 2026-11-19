import { Prisma } from '@prisma/client';
import { getSettlementBaseAmount } from '../utils/orderDispatches/revenueInit';
import { round2, roundMix1 } from '../utils/money/format';

export const unsettledStaffOrderStatuses: Prisma.EnumOrderStatusFilter['in'] = [
    'WAIT_ASSIGN', 'WAIT_ACCEPT', 'ACCEPTED', 'ARCHIVED', 'COMPLETED_PENDING_CONFIRM',
];

export async function getStaffExitOrderReserve(db: Pick<Prisma.TransactionClient, 'orderParticipant' | 'walletTransaction'>, userId: number) {
    const archived = await db.orderParticipant.findMany({
        where: {
            userId, acceptedAt: { not: null }, rejectedAt: null, progressBaseWan: { lt: 0 },
            dispatch: {
                status: 'ARCHIVED',
                order: { status: { in: unsettledStaffOrderStatuses } },
            },
        },
        select: {
            progressBaseWan: true,
            dispatch: { select: { id: true, order: { select: {
                id: true, autoSerial: true, baseAmountWan: true, settlementBaseAmount: true,
                paidAmount: true, receivableAmount: true, originalAmount: true, isGifted: true, projectSnapshot: true,
                project: { select: { billingMode: true } },
            } } } },
        },
    });

    const losses = archived.flatMap(({ dispatch, progressBaseWan }) => {
        const { order, id: dispatchId } = dispatch;
        const snapshot = order.projectSnapshot as { billingMode?: string } | null;
        const mode = snapshot?.billingMode ?? order.project.billingMode;
        if (mode !== 'GUARANTEED' && mode !== 'BASE') return [];
        // 结单可选择按结算基数或按实付，预留覆盖两种口径。
        const paidBasis = Number(order.isGifted ? order.receivableAmount : order.paidAmount) || 0;
        const base = Math.max(getSettlementBaseAmount(order), roundMix1(round2(paidBasis)));
        if (base <= 0 || Number(order.baseAmountWan) <= 0) {
            return [{ dispatchId, orderId: order.id, orderNo: order.autoSerial, estimated: 0, needsReview: true }];
        }
        const estimated = Math.abs(roundMix1(Number(progressBaseWan) / (Number(order.baseAmountWan) / base)));
        return [{ dispatchId, orderId: order.id, orderNo: order.autoSerial, estimated, needsReview: false }];
    });

    const bookedByDispatch = await getBookedBombLossByDispatch(db, userId, losses.map(({ dispatchId }) => dispatchId));
    const items = losses.map((loss) => ({
        ...loss,
        bookedAmount: bookedByDispatch.get(loss.dispatchId) ?? 0,
        amount: Math.max(0, round2(loss.estimated - (bookedByDispatch.get(loss.dispatchId) ?? 0))),
    })).filter((loss) => loss.amount > 0 || loss.needsReview);
    return {
        amount: round2(items.reduce((total, item) => total + item.amount, 0)),
        needsReview: items.some((item) => item.needsReview),
        items,
    };
}

export async function getBookedBombLossByDispatch(
    db: Pick<Prisma.TransactionClient, 'walletTransaction'>, userId: number, dispatchIds: number[],
) {
    const booked = dispatchIds.length ? await db.walletTransaction.findMany({
        where: {
            userId, sourceType: 'ORDER_SETTLEMENT', direction: 'OUT', status: 'AVAILABLE',
            dispatchId: { in: dispatchIds },
            settlementId: { not: null },
            bizType: { in: ['SETTLEMENT_BOMB_LOSS', 'SETTLEMENT_EARNING_BASE', 'SETTLEMENT_EARNING'] },
        },
        select: { dispatchId: true, amount: true },
    }) : [];
    const bookedByDispatch = new Map<number | null, number>();
    for (const row of booked) {
        bookedByDispatch.set(row.dispatchId, (bookedByDispatch.get(row.dispatchId) ?? 0) + Number(row.amount));
    }
    return bookedByDispatch;
}

export function staffExitOrderReserveReason(
    reserve: Awaited<ReturnType<typeof getStaffExitOrderReserve>>, remainingAssets: number,
) {
    if (reserve.needsReview) return '存单炸补缺少有效结算基数，请先核对订单后再提现';
    if (reserve.amount > 0 && round2(remainingAssets) < reserve.amount) {
        return `提现后资金不足以覆盖存单炸补预留 ¥${reserve.amount.toFixed(2)}，请先结算存单或驳回后按可提现金额重新申请`;
    }
    return null;
}
