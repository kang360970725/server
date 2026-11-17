import { recordTournamentReminder, tournamentReminderCandidates, tournamentWechatScheduleRemark } from './live-tournament.reminders';

const now = new Date('2026-11-15T11:00:00Z');

it('selects only active bookings in the hour before the scheduled start', () => {
    expect(tournamentReminderCandidates(now)).toMatchObject({
        status: { in: ['BOOKED', 'QUEUED'] },
        preMatchReminderAt: null,
        day: { startsAt: { gt: now, lte: new Date('2026-11-15T12:00:00Z') } },
    });
});

it('formats a complete WeChat tournament reminder within the thing field limit', () => {
    const text = tournamentWechatScheduleRemark(new Date('2026-11-15T12:00:00Z'));
    expect(text).toBe('11月15日20:00开赛，请提前准备');
    expect(text.length).toBeLessThanOrEqual(20);
});

it('creates one station message when repeated jobs compete for the same ticket', async () => {
    const tx = {
        $queryRaw: jest.fn(),
        order: { findUnique: jest.fn().mockResolvedValue({ status: 'WAIT_ASSIGN' }) },
        liveTournamentEntry: {
            findUnique: jest.fn().mockResolvedValue({ orderId: 11 }),
            updateMany: jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 }),
            findUniqueOrThrow: jest.fn().mockResolvedValue({
                orderId: 11, memberId: 5, day: { startsAt: new Date('2026-11-15T12:00:00Z') }, tournament: { title: '挑战赛' },
            }),
        },
        userNotification: { create: jest.fn().mockResolvedValue({ id: 23 }) },
    };
    await expect(recordTournamentReminder(tx as any, 1, now)).resolves.toMatchObject({
        orderId: 11,
        notificationId: 23,
        wechatContent: '11月15日20:00开赛，请提前准备',
    });
    await expect(recordTournamentReminder(tx as any, 1, now)).resolves.toBeNull();
    expect(tx.userNotification.create).toHaveBeenCalledTimes(1);
    tx.order.findUnique.mockResolvedValue({ status: 'REFUNDED' });
    await expect(recordTournamentReminder(tx as any, 1, now)).resolves.toBeNull();
    expect(tx.liveTournamentEntry.updateMany).toHaveBeenCalledTimes(2);
});
