import { OrdersService } from './orders.service';

describe('OrdersService member order context', () => {
  it('uses the product category, not the order type, for member-discount exclusions', async () => {
    const service: any = Object.create(OrdersService.prototype);
    const rule = {
      benefitId: 9,
      config: {
        rate: 0.95,
        excludedProjectTypes: ['EXPERIENCE'],
        excludedCategoryIds: ['NO_DISCOUNT_CATEGORY'],
      },
    };
    service.prisma = {
      memberProfile: { findUnique: jest.fn().mockResolvedValue({ levelCode: 'V3' }) },
      memberLevelConfig: { findUnique: jest.fn().mockResolvedValue({ id: 3, code: 'V3' }) },
      memberLevelBenefit: { findFirst: jest.fn().mockResolvedValue(rule) },
    };

    const allowed = await service.resolveMemberOrderDiscount({
      customerUserId: 610,
      project: { type: 'EXPERIENCE', category: 'NORMAL_CATEGORY' },
      originalAmount: 100,
    });
    const excluded = await service.resolveMemberOrderDiscount({
      customerUserId: 610,
      project: { type: 'REGULAR', category: 'NO_DISCOUNT_CATEGORY' },
      originalAmount: 100,
    });

    expect(allowed).toMatchObject({ amount: 5, rate: 0.95 });
    expect(excluded).toMatchObject({ amount: 0, rate: 1 });
  });

  it('keeps the legacy order-type exclusion only until categories are configured', async () => {
    const service: any = Object.create(OrdersService.prototype);
    service.prisma = {
      memberProfile: { findUnique: jest.fn().mockResolvedValue({ levelCode: 'V1' }) },
      memberLevelConfig: { findUnique: jest.fn().mockResolvedValue({ id: 1, code: 'V1' }) },
      memberLevelBenefit: { findFirst: jest.fn().mockResolvedValue({
        benefitId: 9,
        config: { rate: 0.98, excludedProjectTypes: ['EXPERIENCE'], excludedCategoryIds: [] },
      }) },
    };

    const result = await service.resolveMemberOrderDiscount({
      customerUserId: 610,
      project: { type: 'EXPERIENCE', category: 'ANY_CATEGORY' },
      originalAmount: 100,
    });

    expect(result).toMatchObject({ amount: 0, rate: 1 });
  });

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
