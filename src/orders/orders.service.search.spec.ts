import { isValidCustomerGameId, OrdersService } from './orders.service';

describe('OrdersService customer identifier search', () => {
  it.each([
    ['123456789', true],
    [' 001234 ', true],
    ['猫猫123', false],
    ['123-456', false],
    ['', false],
  ])('validates supplemented game ID %j', (value, expected) => {
    expect(isValidCustomerGameId(value)).toBe(expected);
  });

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

  it('limits normal list queries to the latest 90 days', async () => {
    const { service, prisma } = createService();
    const before = Date.now();
    await service.listOrders({});
    const cutoff = prisma.order.findMany.mock.calls[0][0].where.createdAt.gte as Date;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 90 * 24 * 60 * 60 * 1000 - 1000);
  });

  it('allows an old order lookup only through an exact full order serial', async () => {
    const { service, prisma } = createService();
    await service.listOrders({ keyword: 'V01HSBMCM63ACH' });
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.autoSerial).toBe('V01HSBMCM63ACH');
    expect(where.createdAt).toBeUndefined();
  });

  it('excludes draft and cancelled orders from the normal order list', async () => {
    const { service, prisma } = createService();

    await service.listOrders({});

    expect(prisma.order.findMany.mock.calls[0][0].where.status).toEqual({
      notIn: ['DRAFT', 'CANCELLED'],
    });
    expect(prisma.order.count.mock.calls[0][0].where.status).toEqual({
      notIn: ['DRAFT', 'CANCELLED'],
    });
  });
});
