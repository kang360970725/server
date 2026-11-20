import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { OrdersService } from './orders.service';

describe('OrdersService deleteOrder', () => {
  const createService = (status: OrderStatus) => {
    const prisma = {
      $queryRawUnsafe: jest.fn(),
      $transaction: jest.fn(async (callback: (tx: any) => unknown) => callback(prisma)),
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 12,
          autoSerial: 'DD202609010001',
          status,
          isPaid: true,
          orderSource: 'OFFLINE',
        }),
        delete: jest.fn().mockResolvedValue({ id: 12 }),
      },
      orderRefund: { count: jest.fn().mockResolvedValue(0) },
      liveTournamentEntry: {
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
      userLog: { create: jest.fn() },
    };
    const service = Object.create(OrdersService.prototype) as OrdersService;
    (service as any).prisma = prisma;
    return { service, prisma };
  };

  it('rejects deletion when the order has not been refunded', async () => {
    const { service, prisma } = createService(OrderStatus.COMPLETED);

    await expect(service.deleteOrder(12, 1)).rejects.toThrow(
      new BadRequestException('仅已退款订单允许删除'),
    );
    expect(prisma.order.delete).not.toHaveBeenCalled();
  });

  it('allows deletion after the order has been refunded', async () => {
    const { service, prisma } = createService(OrderStatus.REFUNDED);

    await expect(service.deleteOrder(12, 1)).resolves.toEqual(expect.objectContaining({
      success: true,
      id: 12,
    }));
    expect(prisma.order.delete).toHaveBeenCalledWith({ where: { id: 12 } });
  });

  it('voids an active tournament ticket before deleting its refunded order', async () => {
    const { service, prisma } = createService(OrderStatus.REFUNDED);
    prisma.liveTournamentEntry.findUnique.mockResolvedValue({ id: 3 });

    await service.deleteOrder(12, 1);

    expect(prisma.liveTournamentEntry.updateMany).toHaveBeenCalledWith({
      where: { orderId: 12, status: { not: 'VOID' } },
      data: { status: 'VOID', activeMemberId: null, dayId: null, queuePosition: null },
    });
    expect(prisma.order.delete).toHaveBeenCalled();
  });

  it('rejects deletion while a manual refund is still awaiting confirmation', async () => {
    const { service, prisma } = createService(OrderStatus.REFUNDED);
    prisma.orderRefund.count.mockResolvedValue(1);

    await expect(service.deleteOrder(12, 1)).rejects.toThrow(
      new BadRequestException('人工退款尚未确认完成，暂不可删除订单'),
    );
    expect(prisma.order.delete).not.toHaveBeenCalled();
  });
});
