import { getTournamentStage, updateTournamentStage } from './live-tournament.stage';

function stageTransaction(status: string, providerId: number | null = null) {
    const entry = {
        id: 12, memberId: 5, status, providerId, gameAccountId: 'private-id',
        contactPhone: 'private-phone', gameNickname: '游戏昵称', competitionName: '参赛昵称',
        firstRoundStartedAt: providerId ? new Date() : null, queuePosition: status === 'QUEUED' ? 1 : null,
    };
    return {
        $queryRaw: jest.fn(),
        liveTournamentDay: {
            findUnique: jest.fn().mockResolvedValue({
                rosterPublishedAt: new Date(), quotas: [{ providerId: 7, minimum: 1, maximum: 1 }],
                entries: [entry], tournament: { id: 1, title: '赛事', status: 'PUBLISHED', ticketLimit: 70 },
            }),
        },
        liveTournamentEntry: {
            findMany: jest.fn().mockResolvedValue([entry]),
            aggregate: jest.fn().mockResolvedValue({ _max: { appearanceSequence: 3 } }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            groupBy: jest.fn().mockResolvedValue([]),
        },
        user: {
            findMany: jest.fn().mockResolvedValue([{ id: 7, name: '服务者', staffRating: { name: '超凡入圣' } }]),
            findUnique: jest.fn().mockResolvedValue({ userType: 'REGISTERED_USER', memberProfile: null }),
        },
    };
}

it('locks one provider after stage entry and preserves the result on retry', async () => {
    const queued = stageTransaction('QUEUED');
    await expect(updateTournamentStage(queued as any, 1, 12, 'stage-draw')).rejects.toThrow('请先确认选手上场');
    const onStage = stageTransaction('ON_STAGE');
    await updateTournamentStage(onStage as any, 1, 12, 'stage-draw');
    expect(onStage.liveTournamentEntry.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: { providerId: 7, drawnAt: expect.any(Date), firstRoundStartedAt: expect.any(Date) },
    }));
    const locked = stageTransaction('ON_STAGE', 7);
    await updateTournamentStage(locked as any, 1, 12, 'stage-draw');
    expect(locked.liveTournamentEntry.updateMany).not.toHaveBeenCalled();
});

it('assigns a permanent appearance sequence when the next player enters the stage', async () => {
    const tx = stageTransaction('QUEUED');
    await updateTournamentStage(tx as any, 1, 12, 'stage-enter');
    expect(tx.liveTournamentEntry.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'ON_STAGE', appearanceSequence: 4, queuePosition: null }),
    }));
});

it('keeps the game ID and contact information out of public projection', async () => {
    const tx = stageTransaction('ON_STAGE', 7);
    const projection = await getTournamentStage(tx as any, 1, false);
    expect(JSON.stringify(projection)).not.toMatch(/private-id|private-phone|gameAccountId|contactPhone/);
    expect((await getTournamentStage(tx as any, 1, true)).current).toMatchObject({ gameAccountId: 'private-id' });
});
