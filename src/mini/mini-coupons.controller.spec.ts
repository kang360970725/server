import { BadRequestException } from '@nestjs/common';
import { CouponTemplateStatus } from '@prisma/client';
import { MiniCouponsController } from './mini-coupons.controller';

describe('MiniCouponsController claim rules', () => {
  const build = (templateOverrides: Record<string, any> = {}, counts: number[] = [0]) => {
    const tx = {
      couponTemplate: {
        findUnique: jest.fn().mockResolvedValue({
          id: 10,
          status: CouponTemplateStatus.ACTIVE,
          miniappClaimEnabled: true,
          startAt: null,
          endAt: null,
          perUserLimit: 1,
          dailyClaimLimit: null,
          totalLimit: null,
          issuedCount: 0,
          ...templateOverrides,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      userCoupon: {
        count: jest.fn().mockImplementation(() => Promise.resolve(counts.shift() ?? 0)),
        create: jest.fn().mockResolvedValue({ id: 99 }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback: any) => callback(tx)),
    };
    return { controller: new MiniCouponsController(prisma as any), tx };
  };

  it('only counts MINIAPP_CLAIM records toward the per-user claim limit', async () => {
    const { controller, tx } = build();

    await controller.claim({ user: { userId: 7 } }, '10');

    expect(tx.userCoupon.count).toHaveBeenCalledWith({
      where: { userId: 7, templateId: 10, sourceType: 'MINIAPP_CLAIM' },
    });
    expect(tx.userCoupon.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sourceType: 'MINIAPP_CLAIM' }),
    }));
  });

  it('rejects a claim when the Shanghai-day quota is exhausted', async () => {
    const { controller, tx } = build({ perUserLimit: null, dailyClaimLimit: 3 }, [0, 3]);

    await expect(controller.claim({ user: { userId: 7 } }, '10'))
      .rejects.toThrow(new BadRequestException('今日优惠券已抢光，请明天再来'));

    expect(tx.userCoupon.create).not.toHaveBeenCalled();
    expect(tx.userCoupon.count).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        templateId: 10,
        sourceType: 'MINIAPP_CLAIM',
        receivedAt: expect.objectContaining({ gte: expect.any(Date), lt: expect.any(Date) }),
      }),
    });
  });
});
