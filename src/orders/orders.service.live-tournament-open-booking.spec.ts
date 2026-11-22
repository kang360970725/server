import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

describe('OrdersService openLiveTournamentBooking', () => {
  function createService(options: { opened?: boolean; futureDays?: number } = {}) {
    const tournament = {
      id: 1,
      title: '板板挑战赛',
      status: 'PUBLISHED',
      bookingThreshold: 40,
      bookingOpenedAt: options.opened ? new Date('2026-11-22T01:00:00Z') : null,
    };
    const tx = {
      $queryRaw: jest.fn(),
      liveTournament: {
        findUnique: jest.fn().mockResolvedValue(tournament),
        update: jest.fn().mockImplementation(({ data }) => ({ ...tournament, ...data })),
      },
      liveTournamentDay: { count: jest.fn().mockResolvedValue(options.futureDays ?? 1) },
      userLog: { create: jest.fn() },
    };
    const prisma = { $transaction: jest.fn(async (callback: (client: any) => unknown) => callback(tx)) };
    const service = Object.create(OrdersService.prototype) as OrdersService;
    (service as any).prisma = prisma;
    return { service, tx };
  }

  it('opens booking early and records the operator reason', async () => {
    const { service, tx } = createService();

    const result = await service.openLiveTournamentBooking(1, 20, '提前开赛，人工开放预约');

    expect(result.bookingOpenedAt).toEqual(expect.any(Date));
    expect(result.idempotent).toBe(false);
    expect(tx.liveTournament.update).toHaveBeenCalledWith({
      where: { id: 1 }, data: { bookingOpenedAt: expect.any(Date) },
    });
    expect(tx.userLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 20,
        action: 'LIVE_TOURNAMENT_OPEN_BOOKING',
        remark: '提前开赛，人工开放预约',
      }),
    }));
  });

  it('requires a future live session before opening booking', async () => {
    const { service, tx } = createService({ futureDays: 0 });

    await expect(service.openLiveTournamentBooking(1, 20, '提前开赛')).rejects.toThrow(
      new BadRequestException('请先创建至少一个尚未开始的直播场次'),
    );
    expect(tx.liveTournament.update).not.toHaveBeenCalled();
  });

  it('is idempotent after booking is already open', async () => {
    const { service, tx } = createService({ opened: true });
    await expect(service.openLiveTournamentBooking(1, 20, '重复点击')).resolves.toEqual(
      expect.objectContaining({ idempotent: true }),
    );
    expect(tx.liveTournament.update).not.toHaveBeenCalled();
  });
});
