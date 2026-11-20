import { OrderStatus } from '@prisma/client';
import { OrdersService } from './orders.service';

describe('OrdersService getMyLiveTournament orphan protection', () => {
  function createService(order: { status: OrderStatus } | null) {
    const prisma = {
      liveTournamentEntry: {
        findFirst: jest.fn().mockResolvedValue({ id: 3 }),
      },
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      user: { findUnique: jest.fn() },
    };
    const service = Object.create(OrdersService.prototype) as OrdersService;
    (service as any).prisma = prisma;
    return { service, prisma };
  }

  it('hides an active-looking tournament entry when its order has been deleted', async () => {
    const { service, prisma } = createService(null);

    await expect(service.getMyLiveTournament(1127, 14923)).resolves.toBeNull();
    expect(prisma.liveTournamentEntry.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { orderId: 14923, memberId: 1127, activeMemberId: 1127, status: { not: 'VOID' } },
    }));
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('hides a tournament entry whose order has been refunded', async () => {
    const { service } = createService({ status: OrderStatus.REFUNDED });
    await expect(service.getMyLiveTournament(174, 14930)).resolves.toBeNull();
  });
});
