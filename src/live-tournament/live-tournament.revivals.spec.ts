import { grantTournamentRevival, revokeTournamentRevival } from './live-tournament.revivals';

describe('live tournament revival', () => {
    it('creates one unbooked attempt from the original paid ticket', async () => {
        const source = {
            id: 10, tournamentId: 3, orderId: 20, memberId: 7, status: 'FINISHED', usedAt: new Date(),
            contactName: '会员', contactPhone: '13800000000', gameAccountId: 'game-7', gameNickname: '选手',
            gameRank: '钻石', competitionName: '蓝猫',
            tournament: {status: 'PUBLISHED', leaderboardLockedAt: null},
            rounds: [{publishedAt: new Date()}, {publishedAt: new Date()}],
        };
        const tx = {
            $queryRaw: jest.fn(),
            liveTournamentEntry: {
                findUnique: jest.fn().mockResolvedValueOnce({tournamentId: 3, orderId: 20}).mockResolvedValueOnce(source),
                findMany: jest.fn().mockResolvedValue([{...source, attemptNumber: 1, isRevival: false}]),
                create: jest.fn().mockImplementation(({data}) => ({id: 11, ...data})),
            },
            userLog: {create: jest.fn()},
        };
        const result = await grantTournamentRevival(tx as any, 10, 2);
        expect(result).toMatchObject({id: 11, orderId: 20, attemptNumber: 2, isRevival: true, status: 'UNBOOKED'});
        expect(tx.liveTournamentEntry.create).toHaveBeenCalledWith({data: expect.objectContaining({
            activeMemberId: 7, revivalGrantedBy: 2,
        })});
    });

    it('revokes an unstarted booked revival and releases its queue position', async () => {
        const entry = {
            id: 12, tournamentId: 3, orderId: 20, dayId: 5, queuePosition: 2,
            isRevival: true, status: 'QUEUED', firstRoundStartedAt: null, usedAt: null,
            providerId: null, appearanceSequence: null, tournament: {status: 'PUBLISHED'},
        };
        const tx = {
            $queryRaw: jest.fn(),
            liveTournamentEntry: {
                findUnique: jest.fn().mockResolvedValueOnce({tournamentId: 3, orderId: 20, dayId: 5}).mockResolvedValueOnce(entry),
                update: jest.fn().mockImplementation(({data}) => ({...entry, ...data})),
                updateMany: jest.fn(),
            },
            userLog: {create: jest.fn()},
        };
        const result = await revokeTournamentRevival(tx as any, 12, 2);
        expect(result).toMatchObject({status: 'VOID', activeMemberId: null, dayId: null, idempotent: false});
        expect(tx.liveTournamentEntry.updateMany).toHaveBeenCalledWith({
            where: {dayId: 5, status: 'QUEUED', queuePosition: {gt: 2}},
            data: {queuePosition: {decrement: 1}},
        });
    });
});
