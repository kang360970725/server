import { OrdersService } from './orders.service';

function fixture(secondRoundForfeited: boolean) {
    const order = { id: 12, status: 'WAIT_ASSIGN', currentDispatchId: null, isPaid: true };
    const dispatch = { id: 41, status: 'COMPLETED', completedAt: new Date() };
    const tx = {
        $queryRaw: jest.fn(),
        order: {
            findUnique: jest.fn(async () => ({ ...order })),
            update: jest.fn(async ({ data, include }) => ({ ...Object.assign(order, data), dispatches: include?.dispatches ? [dispatch] : undefined })),
        },
        liveTournamentEntry: {
            findUnique: jest.fn().mockResolvedValue({
                usedAt: new Date(), status: 'FINISHED', providerId: 9,
                tournament: { providerFee: '36.5' },
                rounds: [
                    { roundNumber: 1, publishedScore: { kills: 0, forfeited: false }, publishedAt: new Date() },
                    { roundNumber: 2, publishedScore: { kills: secondRoundForfeited ? 0 : 3, forfeited: secondRoundForfeited }, publishedAt: new Date() },
                ],
            }),
        },
        orderDispatch: {
            count: jest.fn().mockResolvedValue(0),
            create: jest.fn().mockResolvedValue(dispatch),
        },
        orderSettlement: { findFirst: jest.fn().mockResolvedValue({ settlementBatchId: 'batch-1' }) },
    };
    const service = Object.create(OrdersService.prototype);
    service.prisma = { $transaction: (callback: (client: typeof tx) => unknown) => callback(tx) };
    service.applySettlementPlanTx = jest.fn().mockResolvedValue({ settlementBatchId: 'batch-1', settlements: [{ id: 77 }] });
    service.afterSettlementAppliedTx = jest.fn(async ({ orderStatusToUpdate }) => {
        order.status = orderStatusToUpdate;
    });
    return { service, tx };
}

it.each([false, true])('settles one full fixed fee and reuses the batch on retry (forfeit=%s)', async forfeited => {
    const { service, tx } = fixture(forfeited);
    await expect(service.settleLiveTournamentTicket(12, 2)).resolves.toEqual({
        orderId: 12, settlementBatchId: 'batch-1', idempotent: false,
    });
    await expect(service.settleLiveTournamentTicket(12, 2)).resolves.toEqual({
        orderId: 12, settlementBatchId: 'batch-1', idempotent: true,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.orderDispatch.create).toHaveBeenCalledTimes(1);
    expect(tx.orderDispatch.create).toHaveBeenCalledWith({ data: expect.objectContaining({
        status: 'COMPLETED', participants: { create: { userId: 9 } },
    }) });
    expect(service.applySettlementPlanTx).toHaveBeenCalledTimes(1);
    expect(service.applySettlementPlanTx).toHaveBeenCalledWith(expect.objectContaining({
        order: expect.objectContaining({ dispatches: [expect.objectContaining({ id: 41, completedAt: expect.any(Date) })] }),
        settlementsToCreate: [{ dispatchId: 41, userId: 9, settlementType: 'REGULAR', calculatedEarnings: 36.5, finalEarnings: 36.5 }],
    }));
    expect(service.afterSettlementAppliedTx).toHaveBeenCalledTimes(1);
});
