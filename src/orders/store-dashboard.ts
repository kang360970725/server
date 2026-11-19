import { Prisma } from '@prisma/client';
import { receiptRange } from '../finance/receipt-reconciliation';
import { PrismaService } from '../prisma/prisma.service';

const dayMs = 86_400_000;
const dispatchActions = ['ASSIGN_DISPATCH', 'CREATE_NEW_DISPATCH_AND_SET_PARTICIPANTS', 'UPDATE_DISPATCH_PARTICIPANTS'];

const emptyCounts = () => ({ EXPERIENCE: 0, GUARANTEED: 0, MODE_PLAY: 0, HOURLY: 0, OTHER: 0 });

const categorySelect = {
    projectSnapshot: true,
    project: { select: { type: true, billingMode: true } },
} satisfies Prisma.OrderSelect;

function orderCategory(order: Prisma.OrderGetPayload<{ select: typeof categorySelect }>): keyof ReturnType<typeof emptyCounts> {
    const snapshot = order.projectSnapshot as { type?: string; billingMode?: string } | null;
    if ((snapshot?.type ?? order.project.type) === 'EXPERIENCE') return 'EXPERIENCE';
    const mode = snapshot?.billingMode ?? order.project.billingMode;
    if (mode === 'GUARANTEED' || mode === 'BASE') return 'GUARANTEED';
    if (mode === 'MODE_PLAY' || mode === 'HOURLY') return mode;
    return 'OTHER';
}

export async function getStoreDashboard(prisma: PrismaService, date?: string) {
    const { startAt, endAt, startDate } = receiptRange({ startDate: date, endDate: date });
    const selectedDay = { gte: startAt, lt: endAt };
    const start7 = new Date(endAt.getTime() - 7 * dayMs);
    const start30 = new Date(endAt.getTime() - 30 * dayMs);

    return prisma.$transaction(async (tx) => {
        const [dispatchLogs, receipts, historicalPayments, accepted] = await Promise.all([
            tx.userLog.findMany({
                where: {
                    action: { in: dispatchActions },
                    targetType: 'ORDER',
                    createdAt: selectedDay,
                    user: { userType: 'CUSTOMER_SERVICE' },
                },
                select: { targetId: true },
            }),
            tx.orderReceipt.aggregate({ where: { paidAt: selectedDay }, _sum: { amount: true } }),
            tx.order.findMany({
                where: { paymentTime: selectedDay, isPaid: true, isGifted: false },
                select: { id: true, paidAmount: true },
            }),
            tx.orderParticipant.findMany({
                where: { acceptedAt: { gte: start30, lt: endAt } },
                select: {
                    userId: true, acceptedAt: true,
                    user: { select: { name: true } },
                    dispatch: { select: { order: { select: categorySelect } } },
                },
            }),
        ]);

        const orderIds = [...new Set(dispatchLogs.flatMap(({ targetId }) => targetId === null ? [] : [targetId]))];
        const [dispatchedOrders, trackedPayments] = await Promise.all([
            orderIds.length ? tx.order.findMany({ where: { id: { in: orderIds } }, select: categorySelect }) : [],
            historicalPayments.length ? tx.orderReceipt.findMany({
                where: { orderId: { in: historicalPayments.map(({ id }) => id) }, kind: 'INITIAL' },
                select: { orderId: true },
            }) : [],
        ]);

        const trackedIds = new Set(trackedPayments.map(({ orderId }) => orderId));
        const paidCents = historicalPayments.reduce((total, order) =>
            total + (trackedIds.has(order.id) ? 0 : Math.round(order.paidAmount * 100)),
        Math.round(Number(receipts._sum.amount ?? 0) * 100));

        const orderTypes = emptyCounts();
        for (const order of dispatchedOrders) orderTypes[orderCategory(order)]++;

        const createRow = (userId: number, name: string | null) => ({
            userId, name, selectedCount: 0, count7: 0, count30: 0,
            types7: emptyCounts(), types30: emptyCounts(),
        });
        const byStaff = new Map<number, ReturnType<typeof createRow>>();
        for (const item of accepted) {
            if (!item.acceptedAt) continue;
            const row = byStaff.get(item.userId) ?? createRow(item.userId, item.user.name);
            const category = orderCategory(item.dispatch.order);
            row.count30++;
            row.types30[category]++;
            if (item.acceptedAt >= start7) {
                row.count7++;
                row.types7[category]++;
            }
            if (item.acceptedAt >= startAt) row.selectedCount++;
            byStaff.set(item.userId, row);
        }

        return {
            success: true,
            data: {
                date: startDate,
                dispatchCount: dispatchLogs.length,
                paidAmount: paidCents / 100,
                orderTypes,
                staff: [...byStaff.values()].sort((a, b) => b.selectedCount - a.selectedCount || a.userId - b.userId),
            },
        };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
