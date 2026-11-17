import { publishTournamentRound } from './live-tournament.scores';

it('publishes positive scores with rank movement while excluding a zero-score ticket', async () => {
    const score = (kills: number, elapsed: number | null = null) => ({ kills, firstKillElapsedMs: elapsed, firstKillAtMs: elapsed, forfeited: false });
    const entry = (id: number, kills: number, elapsed: number | null = null) => ({
        id, competitionName: `选手 ${id}`, onStageAt: new Date(id),
        rounds: [{ roundNumber: 1, publishedScore: score(kills, elapsed) }],
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
            findMany: jest.fn().mockResolvedValue([entry(1, 8, 42_350), entry(2, 3, 65_000), entry(3, 0)]),
        },
        liveTournamentRound: { update: jest.fn() },
    };
    await publishTournamentRound(tx as any, 1, 1);
    const snapshot = tx.liveTournament.update.mock.calls[0][0].data.leaderboardSnapshot;
    expect(snapshot.overall).toEqual([
        expect.objectContaining({ ticketId: 1, rank: 1, points: 6, fastestScoreElapsedMs: 42_350, previousRank: null }),
        expect.objectContaining({ ticketId: 2, rank: 2, points: 3, previousRank: 1 }),
    ]);
    expect(snapshot.byKills[0].kills).toBe(8);
});
