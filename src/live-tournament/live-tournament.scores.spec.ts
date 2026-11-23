import { publishTournamentRound } from './live-tournament.scores';

it('publishes positive scores with rank movement and lists zero-score tickets in participation order without a rank', async () => {
    const score = (kills: number, elapsed: number | null = null) => ({ kills, firstKillElapsedMs: elapsed, firstKillAtMs: elapsed, forfeited: false });
    const entry = (id: number, kills: number, elapsed: number | null = null) => ({
        id, memberId: id, competitionName: `选手 ${id}`, onStageAt: new Date(id === 3 ? 5 : id),
        rounds: [
            { roundNumber: 1, publishedScore: score(kills, elapsed) },
            ...(id === 1 ? [{ roundNumber: 2, publishedScore: score(1, 40_012) }] : []),
        ],
    });
    const tx = {
        $queryRaw: jest.fn(),
        liveTournament: {
            findUnique: jest.fn().mockResolvedValue({
                id: 1, status: 'PUBLISHED', leaderboardSnapshot: { overall: [{ ticketId: 2, rank: 1 }] },
            }),
            update: jest.fn(),
        },
        liveTournamentEntry: {
            findUnique: jest.fn().mockResolvedValue({ tournamentId: 1 }),
            findUniqueOrThrow: jest.fn().mockResolvedValue({
                usedAt: new Date(), status: 'SCORING',
                rounds: [{ roundNumber: 1, kills: 8, firstKillElapsedMs: null, firstKillAt: null, forfeited: false }],
            }),
            findMany: jest.fn().mockResolvedValue([entry(1, 8, 42_350), entry(2, 3, 65_000), entry(3, 0), entry(4, 0)]),
        },
        liveTournamentRound: { update: jest.fn() },
    };
    await publishTournamentRound(tx as any, 1, 1);
    const snapshot = tx.liveTournament.update.mock.calls[0][0].data.leaderboardSnapshot;
    expect(snapshot.overall).toEqual([
        expect.objectContaining({ ticketId: 1, rank: 1, points: 7, fastestScoreElapsedMs: 40_012, previousRank: null }),
        expect.objectContaining({ ticketId: 2, rank: 2, points: 3, previousRank: 1 }),
        expect.objectContaining({ ticketId: 4, rank: null, points: 0, previousRank: null }),
        expect.objectContaining({ ticketId: 3, rank: null, points: 0, previousRank: null }),
    ]);
    expect(snapshot.byKills).toEqual([
        expect.objectContaining({ ticketId: 1, rank: 1, kills: 8, roundNumber: 1 }),
        expect.objectContaining({ ticketId: 2, rank: 2, kills: 3 }),
    ]);
    expect(snapshot.byFirstKill).toEqual([
        expect.objectContaining({ ticketId: 1, rank: 1, firstKillElapsedMs: 40_012, roundNumber: 2 }),
        expect.objectContaining({ ticketId: 2, rank: 2, firstKillElapsedMs: 65_000 }),
    ]);
});
