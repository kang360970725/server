import { adminRescheduleTournamentEntry, bookTournament, updateTournamentQueue } from './live-tournament.operations';

const request = { orderId: 9, dayId: 2, gameAccountId: 'player-123', gameNickname: '选手', gameRank: '钻石' };

function bookingTransaction(overrides = {}, occupied = 0) {
    return {
        $queryRaw: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([])
            .mockResolvedValue(Array.from({ length: occupied }, (_, id) => ({ id }))),
        order: { findUniqueOrThrow: jest.fn().mockResolvedValue({ status: 'WAIT_ASSIGN' }) },
        user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ name: '会员', phone: '13800000000', userType: 'REGISTERED_USER' }) },
        userWechatBinding: { findFirst: jest.fn().mockResolvedValue(null) },
        liveTournamentDay: {
            findUnique: jest.fn().mockResolvedValue({ tournamentId: 8, capacity: 2, startsAt: new Date('2099-01-01') }),
        },
        liveTournamentEntry: {
            findUnique: jest.fn().mockResolvedValue({
                id: 10, tournamentId: 8, memberId: 3, activeMemberId: 3, status: 'UNBOOKED', dayId: null,
                tournament: { bookingOpenedAt: new Date(), status: 'PUBLISHED' },
                ...overrides,
            }),
            update: jest.fn().mockResolvedValue({ id: 10 }),
        },
    };
}

describe('tournament booking', () => {
    it('accepts a paid owned ticket and takes contact information from the member', async () => {
        const tx = bookingTransaction();
        await bookTournament(tx as any, 3, request);
        expect(tx.liveTournamentEntry.update).toHaveBeenCalledWith({
            where: { id: 10 },
            data: expect.objectContaining({ dayId: 2, status: 'BOOKED', contactPhone: '13800000000', competitionName: null }),
        });
    });

    it('rejects a full day and another member’s ticket', async () => {
        await expect(bookTournament(bookingTransaction({}, 2) as any, 3, request)).rejects.toThrow('已约满');
        await expect(bookTournament(bookingTransaction() as any, 4, request)).rejects.toThrow('不可预约');
    });

    it('allows one move before the match and drops the old queue position', async () => {
        const tx = bookingTransaction({ dayId: 1, status: 'QUEUED' });
        await bookTournament(tx as any, 3, request);
        expect(tx.liveTournamentEntry.update).toHaveBeenCalledWith({
            where: { id: 10 },
            data: expect.objectContaining({ dayId: 2, status: 'BOOKED', queuePosition: null, rescheduledAt: expect.any(Date) }),
        });
        await expect(bookTournament(bookingTransaction({ dayId: 1, rescheduledAt: new Date() }) as any, 3, request))
            .rejects.toThrow('只能改约一次');
    });
});

describe('tournament queue', () => {
    it('clears stale positions and rewrites the waiting queue in one stable order', async () => {
        const tx = {
            $queryRaw: jest.fn(),
            liveTournamentEntry: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 11, status: 'QUEUED' }, { id: 12, status: 'QUEUED' }, { id: 9, status: 'SCORING' },
                ]),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
        };
        await updateTournamentQueue(tx as any, 3, [12, 11]);
        expect(tx.liveTournamentEntry.updateMany).toHaveBeenNthCalledWith(1, {
            where: { dayId: 3, status: { not: 'QUEUED' }, queuePosition: { not: null } },
            data: { queuePosition: null },
        });
        expect(tx.liveTournamentEntry.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ id: 12 }), data: expect.objectContaining({ queuePosition: 1 }),
        }));
        expect(tx.liveTournamentEntry.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ id: 11 }), data: expect.objectContaining({ queuePosition: 2 }),
        }));
    });
});

describe('admin tournament reschedule', () => {
    it('moves a waiting player to the target queue tail and closes the old queue gap', async () => {
        const tx = {
            $queryRaw: jest.fn().mockResolvedValue([]),
            liveTournamentDay: { findUnique: jest.fn().mockResolvedValue({
                id: 2, tournamentId: 8, capacity: 10, rosterPublishedAt: new Date(), endsAt: new Date('2099-01-01'),
            }) },
            liveTournamentEntry: {
                findUnique: jest.fn()
                    .mockResolvedValueOnce({ tournamentId: 8, dayId: 1 })
                    .mockResolvedValueOnce({
                        id: 10, orderId: 9, tournamentId: 8, dayId: 1, activeMemberId: 3,
                        status: 'QUEUED', queuePosition: 2, appearanceSequence: null,
                        firstRoundStartedAt: null, usedAt: null, providerId: null,
                        tournament: { status: 'PUBLISHED' },
                    }),
                aggregate: jest.fn().mockResolvedValue({ _max: { queuePosition: 3 } }),
                update: jest.fn().mockResolvedValue({ id: 10, orderId: 9, dayId: 2 }),
                updateMany: jest.fn().mockResolvedValue({ count: 2 }),
            },
        };
        await adminRescheduleTournamentEntry(tx as any, 10, 2);
        expect(tx.liveTournamentEntry.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 10 },
            data: expect.objectContaining({ dayId: 2, status: 'QUEUED', queuePosition: 4 }),
        }));
        expect(tx.liveTournamentEntry.updateMany).toHaveBeenCalledWith({
            where: { dayId: 1, status: 'QUEUED', queuePosition: { gt: 2 } },
            data: { queuePosition: { decrement: 1 } },
        });
    });
});
