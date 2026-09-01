import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { OrdersService } from './orders.service';

describe('OrdersService deleteOrder', () => {
  const createService = (status: OrderStatus) => {
    const prisma = {
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
});
