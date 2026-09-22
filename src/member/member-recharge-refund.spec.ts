import { MemberService } from './member.service';

describe('会员充值退款试算与历史资金批次', () => {
  it('按剩余本金扣权益价值后收取30%手续费，赠送金仅收回不参与退款', async () => {
    const prisma: any = {
      memberRechargeOrder: { findUnique: jest.fn().mockResolvedValue({
        id: 9,
        rechargeNo: 'RC9',
        userId: 2,
        status: 'SUCCESS',
        payAmount: 3000,
        bonusAmount: 150,
        levelBeforeCode: 'V1',
        levelAfterCode: 'V3',
        refunds: [],
        balanceLot: { principalInitial: 3000, principalRemaining: 2400, bonusInitial: 150, bonusRemaining: 150 },
        user: { name: '会员甲', memberProfile: { levelCode: 'V3' }, walletAccount: { availableBalance: 2550 } },
      }) },
      memberBenefitUsage: { aggregate: jest.fn().mockResolvedValue({ _sum: { deductedValue: 200 } }) },
      userCoupon: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new MemberService(prisma, {} as any, {} as any, {} as any, {} as any);
    const preview = await service.previewRechargeRefund(9);
    expect(preview).toMatchObject({
      consumedPrincipal: 600,
      principalRemaining: 2400,
      recoveredBonus: 150,
      usedBenefitValue: 200,
      refundablePrincipal: 2200,
      serviceFeeAmount: 660,
      actualRefundAmount: 1540,
      walletRecoveryAmount: 2550,
      suggestedLevelCode: 'V1',
      canRefund: true,
    });
  });

  it('历史重建严格先消耗全部本金，再消耗赠送金', () => {
    const service: any = new MemberService({} as any, {} as any, {} as any, {} as any, {} as any);
    const plan = service.buildHistoricalLotPlan([
      { id: 1, rechargeNo: 'R1', payAmount: 100, bonusAmount: 10 },
      { id: 2, rechargeNo: 'R2', payAmount: 200, bonusAmount: 20 },
    ], 250);
    expect(plan.rows).toEqual([
      expect.objectContaining({ rechargeOrderId: 1, principalRemaining: 0, bonusRemaining: 10 }),
      expect.objectContaining({ rechargeOrderId: 2, principalRemaining: 50, bonusRemaining: 20 }),
    ]);
    expect(plan.unallocatedConsumption).toBe(0);
  });
});
