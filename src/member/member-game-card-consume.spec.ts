import { MemberService } from './member.service';

describe('MemberService game-card linked consumption', () => {
  it('recalculates valid paid consumption and subtracts refunds', async () => {
    const service: any = Object.create(MemberService.prototype);
    service.generateMemberCode = jest.fn().mockResolvedValue('15000001');
    service.prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([
          { paidAmount: 500, finalPayableAmount: 500, isTestPayment: false, refunds: [] },
          { paidAmount: 800, finalPayableAmount: 800, isTestPayment: false, refunds: [{ amount: 200 }] },
          { paidAmount: 0.01, finalPayableAmount: 300, isTestPayment: true, refunds: [] },
        ]),
      },
      memberProfile: { upsert: jest.fn().mockResolvedValue({}) },
    };

    const total = await service.recalculateMemberTotalConsume(610);

    expect(total).toBe(1400);
    expect(service.prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ customerUserId: 610, isGifted: false }),
    }));
    expect(service.prisma.memberProfile.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 610 },
      update: { totalConsumeAmount: 1400 },
    }));
  });
});
