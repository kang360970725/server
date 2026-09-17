import { OrdersService } from './orders.service';

describe('OrdersService customer identifier search', () => {
  const createService = () => {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _sum: { receivableAmount: 0, paidAmount: 0 } }),
      },
    };
    const service = Object.create(OrdersService.prototype) as OrdersService;
    (service as any).prisma = prisma;
    (service as any).getOrderSourceOptions = jest.fn().mockResolvedValue([]);
    return { service, prisma };
  };

  it('searches both the original nickname/room and the supplemented accurate game ID', async () => {
    const { service, prisma } = createService();

    await service.listOrders({ customerGameId: '猫猫房间' });

    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: [{
          OR: [
            { customerGameId: { contains: '猫猫房间' } },
            { customerOriginalIdentifier: { contains: '猫猫房间' } },
          ],
        }],
      }),
    }));
  });

  it('includes both customer identifier fields in the global keyword search', async () => {
    const { service, prisma } = createService();

    await service.listOrders({ keyword: '房间888' });

    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(expect.arrayContaining([
      { customerOriginalIdentifier: { contains: '房间888' } },
      { customerGameId: { contains: '房间888' } },
    ]));
  });
});
