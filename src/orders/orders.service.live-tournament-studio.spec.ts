import { OrdersService } from './orders.service';

const tournament = { id: 1, title: '老板杯活动' };
const day = (id: number, startsAt: string, endsAt: string) => ({
    id,
    tournamentId: tournament.id,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    capacity: 10,
    rosterPublishedAt: new Date(startsAt),
    tournament,
    _count: { entries: 3 },
});

async function resolve(days: ReturnType<typeof day>[], now: string) {
    const prisma = { liveTournamentDay: { findMany: jest.fn().mockResolvedValue(days) } };
    const result = await (OrdersService.prototype.resolveLiveTournamentStudioDay as any)
        .call({ prisma }, new Date(now));
    return { result, findMany: prisma.liveTournamentDay.findMany };
}

describe('resolveLiveTournamentStudioDay', () => {
    it('优先关联当前正在进行的场次，而不是更早或更晚的场次', async () => {
        const { result } = await resolve([
            day(10, '2026-11-19T02:00:00.000Z', '2026-11-19T04:00:00.000Z'),
            day(11, '2026-11-19T07:00:00.000Z', '2026-11-19T09:00:00.000Z'),
            day(12, '2026-11-19T11:00:00.000Z', '2026-11-19T13:00:00.000Z'),
        ], '2026-11-19T08:00:00.000Z');

        expect(result.day.id).toBe(11);
        expect(result.day.state).toBe('IN_PROGRESS');
    });

    it('尚未开场时关联今日最近的一场', async () => {
        const { result } = await resolve([
            day(11, '2026-11-19T12:00:00.000Z', '2026-11-19T14:00:00.000Z'),
            day(12, '2026-11-19T15:00:00.000Z', '2026-11-19T17:00:00.000Z'),
        ], '2026-11-19T08:00:00.000Z');

        expect(result.day.id).toBe(11);
        expect(result.day.state).toBe('UPCOMING');
    });

    it('今日没有已发布场次时安全停止，不猜测其他日期', async () => {
        const { result, findMany } = await resolve([], '2026-11-19T08:00:00.000Z');

        expect(result.day).toBeNull();
        expect(result.message).toContain('今日暂无');
        expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ tournament: { status: 'PUBLISHED' } }),
        }));
    });
});
