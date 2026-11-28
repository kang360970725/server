import { OrdersService } from './orders.service';

it('allows another revival only from the latest finished attempt', async () => {
    const original = {
        id: 10, orderId: 20, memberId: 7, attemptNumber: 1, isRevival: false,
        status: 'FINISHED', queuePosition: null, onStageAt: new Date('2026-11-20'),
        rounds: [], revivalSettlement: null,
    };
    const firstRevival = {
        ...original, id: 11, attemptNumber: 2, isRevival: true,
        onStageAt: new Date('2026-11-21'), revivalSettlement: {id: 1},
    };
    const prisma = {
        liveTournamentEntry: {
            findMany: jest.fn()
                .mockResolvedValueOnce([original, firstRevival])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([
                    {id: 11, orderId: 20, attemptNumber: 2},
                    {id: 10, orderId: 20, attemptNumber: 1},
                ]),
        },
        order: {findMany: jest.fn().mockResolvedValue([{id: 20}])},
        user: {findMany: jest.fn().mockResolvedValue([{
            id: 7, avatar: null, memberProfile: {memberCode: '15000007'},
        }])},
    };
    const service = Object.create(OrdersService.prototype) as any;
    service.prisma = prisma;

    const rows = await service.getLiveTournamentDayEntries(3);
    expect(rows.find((row: any) => row.id === 10)).toMatchObject({canGrantRevival: false, activeRevival: null});
    expect(rows.find((row: any) => row.id === 11)).toMatchObject({canGrantRevival: true, activeRevival: null});
});

it('suppresses another revival while a newer attempt is still active', async () => {
    const finished = {
        id: 11, orderId: 20, memberId: 7, attemptNumber: 2, isRevival: true,
        status: 'FINISHED', queuePosition: null, onStageAt: new Date(), rounds: [], revivalSettlement: {id: 1},
    };
    const active = {id: 12, orderId: 20, status: 'UNBOOKED', dayId: null, attemptNumber: 3};
    const prisma = {
        liveTournamentEntry: {
            findMany: jest.fn()
                .mockResolvedValueOnce([finished])
                .mockResolvedValueOnce([active])
                .mockResolvedValueOnce([{id: 11, orderId: 20, attemptNumber: 2}]),
        },
        order: {findMany: jest.fn().mockResolvedValue([{id: 20}])},
        user: {findMany: jest.fn().mockResolvedValue([{id: 7, avatar: null, memberProfile: null}])},
    };
    const service = Object.create(OrdersService.prototype) as any;
    service.prisma = prisma;

    const [row] = await service.getLiveTournamentDayEntries(3);
    expect(row).toMatchObject({canGrantRevival: false, activeRevival: active});
});
