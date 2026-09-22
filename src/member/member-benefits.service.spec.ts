import { BadRequestException } from '@nestjs/common';
import { MemberBenefitsService } from './member-benefits.service';

describe('MemberBenefitsService', () => {
  it('审核模式从等级权益中剔除受限权益', async () => {
    const prisma: any = {
      memberLevelConfig: {
        findMany: jest.fn().mockResolvedValue([{ id: 1, code: 'V1', minRechargeAmount: 3000, levelBenefits: [] }]),
      },
    };
    const service = new MemberBenefitsService(prisma);
    await service.listLevelBenefits({ reviewMode: true, enabledOnly: true });
    expect(prisma.memberLevelConfig.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: { levelBenefits: expect.objectContaining({ where: expect.objectContaining({ benefit: { reviewRestricted: false } }) }) },
    }));
  });

  it('同一等级不能重复关联同一权益', async () => {
    const prisma: any = {
      memberLevelConfig: { findUnique: jest.fn().mockResolvedValue({ id: 1, code: 'V1' }) },
    };
    const service = new MemberBenefitsService(prisma);
    await expect(service.replaceLevelBenefits(1, [
      { benefitId: 9, grantMode: 'IDENTITY' },
      { benefitId: 9, grantMode: 'IDENTITY' },
    ])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('逐级升级分别发放，跳级只发目标等级的一次性权益', async () => {
    const created: any[] = [];
    const tx: any = {
      memberLevelConfig: { findMany: jest.fn().mockResolvedValue([
        { id: 1, code: 'V1', sortOrder: 100 },
        { id: 4, code: 'V4', sortOrder: 400 },
      ]) },
      memberLevelBenefit: { findMany: jest.fn().mockResolvedValue([
        { benefitId: 8, grantMode: 'UPGRADE_ONCE', unlimited: false, quantity: 2, validityDays: null, benefit: { enabled: true, name: '视频剪辑', unitName: '条', unitValue: 50 } },
      ]) },
      memberBenefitGrant: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => { created.push(data); return { id: created.length, ...data }; }),
      },
    };
    const service = new MemberBenefitsService({} as any);
    await service.grantForLevelChange({ tx, userId: 2, beforeLevelCode: 'V1', afterLevelCode: 'V4', sourceType: 'ADMIN_LEVEL_CHANGE' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ levelCodeSnapshot: 'V4', sourceType: 'LEVEL_UPGRADE', totalQuantity: 2 });
  });

  it('权益核销按发放时价值快照计算退款扣减价值', async () => {
    const tx: any = {
      memberBenefitGrant: {
        findUnique: jest.fn().mockResolvedValue({ id: 5, userId: 2, status: 'ACTIVE', unlimited: false, totalQuantity: 3, usedQuantity: 0, unitValueSnapshot: 80, benefit: { refundableDeduction: true } }),
        update: jest.fn(),
      },
      memberBenefitUsage: { create: jest.fn().mockImplementation(({ data }) => data) },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    const service = new MemberBenefitsService(prisma);
    const result: any = await service.useBenefit(5, { quantity: 2 }, 7);
    expect(result.deductedValue).toBe(160);
    expect(tx.memberBenefitGrant.update).toHaveBeenCalled();
  });
});
