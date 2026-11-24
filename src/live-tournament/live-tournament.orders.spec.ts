import { activateTournamentTicket, prepareTournamentTicket, saveTournamentRound, voidTournamentTicket } from './live-tournament.orders';

const sale = {
    projectId: 1,
    memberId: 7,
    quantity: 1,
    admin: true,
    gifted: false,
    paidOrOnline: true,
    manualDispatch: false,
};

function transaction() {
    return {
        $queryRaw: jest.fn().mockResolvedValue([]),
        liveTournament: {
            findFirst: jest.fn().mockResolvedValue({
                id: 1, status: 'PUBLISHED', salesStartAt: new Date(0),
                salesEndAt: new Date('2099-01-01'), ticketLimit: 70,
            }),
            findUnique: jest.fn().mockResolvedValue({ status: 'PUBLISHED' }),
            findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 1, bookingThreshold: 40 }),
            updateMany: jest.fn(),
        },
        user: { findUnique: jest.fn().mockResolvedValue({ userType: 'REGISTERED_USER' }) },
        liveTournamentEntry: {
            findUnique: jest.fn().mockResolvedValue({ tournamentId: 1 }),
            findFirst: jest.fn().mockResolvedValue({ id: 1, tournamentId: 1 }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            update: jest.fn(),
        },
        liveTournamentRound: { upsert: jest.fn().mockResolvedValue({ kills: 0 }) },
        order: { findUniqueOrThrow: jest.fn().mockResolvedValue({ status: 'WAIT_ASSIGN' }) },
    };
}

describe('live tournament order rules', () => {
    it('rejects certified providers', async () => {
        const tx = transaction();
        tx.user.findUnique.mockResolvedValue({ userType: 'STAFF' });
        await expect(prepareTournamentTicket(tx as any, { ...sale, manualDispatch: true, paidOrOnline: false }))
            .rejects.toThrow('店内认证服务者不可购买本赛事门票或参赛');
    });

    it('blocks an existing member ticket and rejects the 71st active ticket', async () => {
        const tx = transaction();
        tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ activeMemberId: 7 }]);
        await expect(prepareTournamentTicket(tx as any, sale)).rejects.toThrow('已购买或正在支付');
        tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce(
            Array.from({ length: 70 }, (_, index) => ({ activeMemberId: index + 10 })),
        );
        await expect(prepareTournamentTicket(tx as any, sale)).rejects.toThrow('售罄');
    });

    it.each([39, 40])('opens booking at 40 paid tickets, observed %i', async (paid) => {
        const tx = transaction();
        tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce(Array.from({ length: paid }, () => ({ id: 1 })));
        await activateTournamentTicket(tx as any, 1);
        expect(tx.liveTournament.updateMany).toHaveBeenCalledTimes(paid === 40 ? 1 : 0);
    });

    it('redeems a valid zero score and refuses a score on a refunded order', async () => {
        const tx = transaction();
        tx.$queryRaw.mockResolvedValue([{ id: 1, status: 'ON_STAGE', usedAt: null, firstRoundStartedAt: new Date() }]);
        const input = { orderId: 1, roundNumber: 1, kills: 0, firstKillElapsedMs: null, firstKillAt: null };
        await expect(saveTournamentRound(tx as any, input)).resolves.toMatchObject({ points: 0 });
        expect(tx.liveTournamentEntry.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { usedAt: expect.any(Date) } });
        tx.order.findUniqueOrThrow.mockResolvedValue({ status: 'REFUNDED' });
        await expect(saveTournamentRound(tx as any, input)).rejects.toThrow('已退款');
        expect(tx.liveTournamentRound.upsert).toHaveBeenCalledTimes(1);
    });

    it('does not redeem a ticket before the host records the first round start', async () => {
        const tx = transaction();
        tx.$queryRaw.mockResolvedValue([{ id: 1, status: 'ON_STAGE', usedAt: null, firstRoundStartedAt: null }]);
        await expect(saveTournamentRound(tx as any, {
            orderId: 1, roundNumber: 1, kills: 0, firstKillElapsedMs: null, firstKillAt: null,
        })).rejects.toThrow('请先记录首局开打');
        expect(tx.liveTournamentRound.upsert).not.toHaveBeenCalled();
        expect(tx.liveTournamentEntry.update).not.toHaveBeenCalled();
    });

    it('releases purchase and queue positions on withdrawal', async () => {
        const tx = transaction();
        await voidTournamentTicket(tx as any, 1);
        expect(tx.liveTournamentEntry.updateMany).toHaveBeenCalledWith({
            where: { orderId: 1, status: { not: 'VOID' } },
            data: { status: 'VOID', activeMemberId: null, dayId: null, queuePosition: null },
        });
    });
});
