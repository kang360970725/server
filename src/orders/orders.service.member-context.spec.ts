import { OrdersService } from './orders.service';

describe('OrdersService member order context', () => {
  it('returns the calculated discount and primary game card for dispatch', async () => {
    const service: any = Object.create(OrdersService.prototype);
    service.resolveMemberOrderDiscount = jest.fn().mockResolvedValue({
      amount: 5,
      rate: 0.95,
      levelCode: 'V3',
      benefitId: 9,
    });
    service.prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 610 }) },
      gameProject: { findUnique: jest.fn().mockResolvedValue({ id: 8, type: 'REGULAR', category: 'A', gameType: 'DELTA' }) },
      memberGameCard: { findMany: jest.fn().mockResolvedValue([
        { id: 2, gameUniqueId: '123456', gameNickname: '蓝猫', isPrimary: true },
        { id: 3, gameUniqueId: '654321', gameNickname: '备用', isPrimary: false },
      ]) },
    };

    const result = await service.getMemberOrderContext({ userId: 610, projectId: 8, originalAmount: 100 });

    expect(result.memberDiscount).toMatchObject({ applied: true, levelCode: 'V3', amount: 5, payableAmount: 95 });
    expect(result.primaryGameCard).toMatchObject({ gameUniqueId: '123456', isPrimary: true });
    expect(service.prisma.memberGameCard.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 610, gameCategoryId: 'DELTA' },
    }));
  });
});
