import { OrdersService } from './orders.service';

describe('OrdersService updateLiveTournamentDayTime', () => {
  const originalStart = new Date('2099-01-01T12:00:00.000Z');
  const originalEnd = new Date('2099-01-01T14:00:00.000Z');

  function createService(options: { conflict?: boolean; started?: boolean } = {}) {
    const day = {
      id: 3,
      tournamentId: 8,
      startsAt: originalStart,
      endsAt: originalEnd,
      tournament: { id: 8, status: 'PUBLISHED' },
    };
    const tx = {
      $queryRaw: jest.fn(),
      liveTournamentDay: {
        findUnique: jest.fn()
          .mockResolvedValueOnce({ tournamentId: 8 })
          .mockResolvedValueOnce(day),
        findFirst: jest.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(options.conflict ? { id: 4 } : null),
        update: jest.fn().mockImplementation(({ data }) => ({ ...day, ...data })),
        aggregate: jest.fn().mockResolvedValue({
          _min: { startsAt: new Date('2099-01-01T13:00:00.000Z') },
          _max: { endsAt: new Date('2099-01-01T15:00:00.000Z') },
        }),
      },
      liveTournamentEntry: {
        count: jest.fn().mockResolvedValue(options.started ? 1 : 0),
        findMany: jest.fn().mockResolvedValue([{ orderId: 91 }, { orderId: 92 }]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      liveTournament: { update: jest.fn() },
      userLog: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: any) => unknown) => callback(tx)),
    };
    const miniSubscribeMessageService = {
      pushOrderProgressMessage: jest.fn().mockResolvedValue({ stationNotificationId: 1 }),
    };
    const service = Object.create(OrdersService.prototype) as OrdersService;
    (service as any).prisma = prisma;
    (service as any).miniSubscribeMessageService = miniSubscribeMessageService;
    (service as any).logger = { warn: jest.fn() };
    return { service, tx, miniSubscribeMessageService };
  }

  it('updates the day, resets reminders, writes an audit log and notifies booked players', async () => {
    const { service, tx, miniSubscribeMessageService } = createService();

    const result = await service.updateLiveTournamentDayTime(3, 20, {
      startsAt: '2099-01-01T21:00:00+08:00',
      endsAt: '2099-01-01T23:00:00+08:00',
      reason: '直播临时延后一小时',
    });

    expect(result.notifiedOrders).toBe(2);
    expect(tx.liveTournamentDay.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: expect.objectContaining({
        startsAt: new Date('2099-01-01T13:00:00.000Z'),
        endsAt: new Date('2099-01-01T15:00:00.000Z'),
      }),
    });
    expect(tx.liveTournamentEntry.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { preMatchReminderAt: null },
    }));
    expect(tx.userLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 20,
        action: 'LIVE_TOURNAMENT_UPDATE_DAY_TIME',
        remark: '直播临时延后一小时',
      }),
    }));
    expect(miniSubscribeMessageService.pushOrderProgressMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects a time range that conflicts with another tournament day', async () => {
    const { service, tx } = createService({ conflict: true });

    await expect(service.updateLiveTournamentDayTime(3, 20, {
      startsAt: '2099-01-01T21:00:00+08:00',
      endsAt: '2099-01-01T23:00:00+08:00',
      reason: '临时调整时间',
    })).rejects.toThrow('调整后的时间与已有直播场次冲突');
    expect(tx.liveTournamentDay.update).not.toHaveBeenCalled();
  });

  it('keeps the original start once a player has started but permits changing the end', async () => {
    const { service, tx } = createService({ started: true });

    await expect(service.updateLiveTournamentDayTime(3, 20, {
      startsAt: '2099-01-01T21:00:00+08:00',
      endsAt: '2099-01-01T23:00:00+08:00',
      reason: '试图修改开始时间',
    })).rejects.toThrow('比赛已经开始，只能延长或缩短结束时间');

    const second = createService({ started: true });
    await expect(second.service.updateLiveTournamentDayTime(3, 20, {
      startsAt: '2099-01-01T20:00:00+08:00',
      endsAt: '2099-01-01T23:00:00+08:00',
      reason: '直播延长一小时',
    })).resolves.toEqual(expect.objectContaining({ notifiedOrders: 2 }));
    expect(second.tx.liveTournamentEntry.updateMany).not.toHaveBeenCalled();
  });
});
