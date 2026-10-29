import { ConflictException } from '@nestjs/common';
import { OrdersService } from './orders.service';

describe('OrdersService order claim', () => {
  const serviceWith = (prisma: any) => {
    const service = Object.create(OrdersService.prototype) as OrdersService;
    (service as any).prisma = prisma;
    return service;
  };

  it('returns only masked data before login', async () => {
    const service = serviceWith({
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 7,
          autoSerial: 'V01ABCDEFGH',
          status: 'WAIT_ASSIGN',
          createdAt: new Date('2026-10-27T01:00:00Z'),
          customerUserId: null,
          project: {name: '测试项目', coverImage: null},
          projectSnapshot: {},
        }),
      },
    });
    await expect(service.getOrderClaimPreview('a'.repeat(32))).resolves.toMatchObject({
      orderId: 7,
      orderNoMasked: 'V01***FGH',
      projectName: '测试项目',
      claimed: false,
    });
  });

  it('atomically binds the first logged-in member', async () => {
    const tx = {
      order: {
        findUnique: jest.fn().mockResolvedValue({id: 7, customerUserId: null}),
        updateMany: jest.fn().mockResolvedValue({count: 1}),
      },
      userLog: {create: jest.fn().mockResolvedValue({id: 1})},
    };
    const service = serviceWith({$transaction: (fn: any) => fn(tx)});
    await expect(service.claimOrderForMember('b'.repeat(32), 99)).resolves.toEqual({
      orderId: 7,
      claimed: true,
      alreadyOwned: false,
    });
    expect(tx.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {id: 7, claimToken: 'b'.repeat(32), customerUserId: null},
      data: expect.objectContaining({customerUserId: 99}),
    }));
  });

  it('never rebinds an order owned by another member', async () => {
    const tx = {
      order: {findUnique: jest.fn().mockResolvedValue({id: 7, customerUserId: 100})},
      userLog: {create: jest.fn()},
    };
    const service = serviceWith({$transaction: (fn: any) => fn(tx)});
    await expect(service.claimOrderForMember('c'.repeat(32), 99)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.userLog.create).not.toHaveBeenCalled();
  });
});
