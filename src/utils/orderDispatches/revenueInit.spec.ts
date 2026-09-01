import { BillingMode, DispatchStatus } from '@prisma/client';
import { OrdersService } from '../../orders/orders.service';
import {
  buildGuaranteedEffectiveProgress,
  computeBillingGuaranteed,
  computeBillingHours,
  computeBillingMODEPLAY,
} from './revenueInit';

const guaranteedRound = (id: number, round: number, status: DispatchStatus, progress?: Array<[number, number]>) => ({
  id, round, status,
  participants: (progress || [[id * 10, 0]]).map(([participantId, value]) => ({
    id: participantId, userId: participantId, acceptedAt: new Date('2026-08-31T00:00:00Z'),
    rejectedAt: null, isActive: status === DispatchStatus.COMPLETED, progressBaseWan: value,
    user: { name: `玩家${participantId}` },
  })),
});

describe('保底单末轮项目级策略', () => {
  it('最后一组全额结算：历史正收益为 0，炸单负收益保留并回灌末轮', () => {
    const order = { id: 1, status: 'COMPLETED_PENDING_CONFIRM', baseAmountWan: 1000,
      settlementBaseAmount: 100, projectSnapshot: { clubRate: 0.2, guaranteedSettlementMode: 'FINAL_ROUND_TAKES_ALL' },
      dispatches: [guaranteedRound(1, 1, DispatchStatus.ARCHIVED, [[11, 300]]),
        guaranteedRound(2, 2, DispatchStatus.ARCHIVED, [[21, -100]]),
        guaranteedRound(3, 3, DispatchStatus.COMPLETED, [[31, 0]])] };
    const rows = computeBillingGuaranteed(order);
    expect(rows.map(r => [r.dispatchId, r.contributionBaseAmount, r.finalEarnings])).toEqual([
      [1, 0, 0], [2, -10, -10], [3, 110, 88],
    ]);
    expect(rows[2].clubEarnings).toBe(22);
  });

  it('全额模式末轮不再被默认中评降为65%，历史零收益参与人不能获得打赏', async () => {
    const order: any = { id: 11, status: 'COMPLETED_PENDING_CONFIRM', baseAmountWan: 1000,
      settlementBaseAmount: 100, projectSnapshot: { clubRate: 0.2, billingMode: 'GUARANTEED', guaranteedSettlementMode: 'FINAL_ROUND_TAKES_ALL' },
      dispatches: [guaranteedRound(11, 1, DispatchStatus.ARCHIVED, [[111, 300]]),
        guaranteedRound(12, 2, DispatchStatus.COMPLETED, [[121, 0]])] };
    const rows = computeBillingGuaranteed(order);
    const service: any = Object.create(OrdersService.prototype);
    const applied = await service.applyPlayerEvaluationAdjustmentsToSettlements({ order, settlementsToCreate: rows, autoConfirm: true });
    expect(applied.settlementsToCreate.map((r: any) => [r.dispatchId, r.finalEarnings])).toEqual([[11, 0], [12, 79]]);
    await expect(service.applyPlayerEvaluationAdjustmentsToSettlements({ order,
      settlementsToCreate: computeBillingGuaranteed(order), autoConfirm: true, orderTipEnabled: true, orderTipUserIds: [111] }))
      .rejects.toThrow('不允许打赏');
  });

  it('600万规则只从倒数第二轮扣足所需进度', () => {
    const order = { id: 2, status: 'COMPLETED_PENDING_CONFIRM', baseAmountWan: 2000,
      settlementBaseAmount: 200, projectSnapshot: { clubRate: 0, guaranteedSettlementMode: 'STANDARD', minimumFinalProgressWan: 600 },
      dispatches: [guaranteedRound(1, 1, DispatchStatus.ARCHIVED, [[11, 900]]),
        guaranteedRound(2, 2, DispatchStatus.ARCHIVED, [[21, 700]]),
        guaranteedRound(3, 3, DispatchStatus.COMPLETED, [[31, 0]])] };
    expect(computeBillingGuaranteed(order).map(r => [r.dispatchId, r.contributionBaseAmount])).toEqual([
      [1, 90], [2, 50], [3, 60],
    ]);
  });

  it('800万规则跨多轮由近到远倒扣，炸单进度不参与扣减', () => {
    const order = { id: 3, status: 'COMPLETED_PENDING_CONFIRM', baseAmountWan: 1500,
      settlementBaseAmount: 150, projectSnapshot: { clubRate: 0, guaranteedSettlementMode: 'STANDARD', minimumFinalProgressWan: 800 },
      dispatches: [guaranteedRound(1, 1, DispatchStatus.ARCHIVED, [[11, 900], [12, -100]]),
        guaranteedRound(2, 2, DispatchStatus.ARCHIVED, [[21, 500]]),
        guaranteedRound(3, 3, DispatchStatus.COMPLETED, [[31, 0]])] };
    const plan = buildGuaranteedEffectiveProgress(order);
    expect(plan.transferredProgressWan).toBe(600);
    expect(computeBillingGuaranteed(order).map(r => [r.userId, r.contributionBaseAmount])).toEqual([
      [11, 80], [12, -10], [21, 0], [31, 80],
    ]);
  });

  it('订单快照优先于商品后来修改，老快照缺字段才读取当前商品配置', () => {
    expect(buildGuaranteedEffectiveProgress({ baseAmountWan: 1000,
      projectSnapshot: { guaranteedSettlementMode: 'STANDARD', minimumFinalProgressWan: null },
      project: { guaranteedSettlementMode: 'FINAL_ROUND_TAKES_ALL', minimumFinalProgressWan: 800 }, dispatches: [] }).policy)
      .toEqual({ mode: 'STANDARD', minimumFinalProgressWan: 0 });
    expect(buildGuaranteedEffectiveProgress({ baseAmountWan: 1000, projectSnapshot: {},
      project: { guaranteedSettlementMode: 'STANDARD', minimumFinalProgressWan: 800 }, dispatches: [] }).policy.minimumFinalProgressWan)
      .toBe(800);
  });
});

describe('computeBillingHours', () => {
  it('ignores archived dispatch rounds without settlement participants', () => {
    const settlements = computeBillingHours({
      id: 10,
      orderQuantity: 1,
      paidAmount: 100,
      projectSnapshot: {
        price: 100,
      },
      dispatches: [
        {
          id: 101,
          round: 1,
          status: DispatchStatus.ARCHIVED,
          archivedAt: new Date('2026-06-27T09:00:00.000Z'),
          participants: [],
        },
        {
          id: 102,
          round: 2,
          status: DispatchStatus.COMPLETED,
          completedAt: new Date('2026-06-27T10:00:00.000Z'),
          participants: [
            {
              id: 1002,
              userId: 2002,
              isActive: false,
              acceptedAt: new Date('2026-06-27T09:30:00.000Z'),
              rejectedAt: null,
              user: { name: '最终结单打手' },
            },
          ],
        },
      ],
    });

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      dispatchId: 102,
      userId: 2002,
      finalEarnings: 100,
    });
  });

  it('still rejects completed dispatch rounds without settlement participants', () => {
    expect(() =>
      computeBillingHours({
        id: 11,
        orderQuantity: 1,
        paidAmount: 100,
        projectSnapshot: {
          price: 100,
        },
        dispatches: [
          {
            id: 111,
            round: 1,
            status: DispatchStatus.COMPLETED,
            completedAt: new Date('2026-06-27T10:00:00.000Z'),
            participants: [],
          },
        ],
      }),
    ).toThrow('派单记录有误，无法完成核算');
  });

  it('excludes replaced participants who never accepted the finalized dispatch', () => {
    const settlements = computeBillingHours({
      id: 1,
      orderQuantity: 1,
      paidAmount: 100,
      projectSnapshot: {
        price: 100,
      },
      dispatches: [
        {
          id: 11,
          round: 1,
          status: DispatchStatus.COMPLETED,
          completedAt: new Date('2026-06-27T10:00:00.000Z'),
          participants: [
            {
              id: 101,
              userId: 1001,
              isActive: false,
              acceptedAt: null,
              rejectedAt: null,
              user: { name: '被替换未接单的人' },
            },
            {
              id: 102,
              userId: 1002,
              isActive: false,
              acceptedAt: new Date('2026-06-27T09:00:00.000Z'),
              rejectedAt: null,
              user: { name: '实际接单的人' },
            },
          ],
        },
      ],
    });

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      dispatchId: 11,
      userId: 1002,
      finalEarnings: 100,
    });
  });
});

describe('finalized dispatch settlement participant filter', () => {
  const finalizedParticipants = [
    {
      id: 101,
      userId: 1001,
      isActive: false,
      acceptedAt: null,
      rejectedAt: null,
      user: { name: '被替换未接单的人' },
    },
    {
      id: 102,
      userId: 1002,
      isActive: false,
      acceptedAt: new Date('2026-06-27T09:00:00.000Z'),
      rejectedAt: null,
      user: { name: '实际接单的人' },
    },
  ];

  it('skips empty archived rounds for guaranteed settlement rebuilds', () => {
    const settlements = computeBillingGuaranteed({
      id: 20,
      status: 'COMPLETED_PENDING_CONFIRM',
      baseAmountWan: 100,
      paidAmount: 100,
      billingMode: BillingMode.GUARANTEED,
      projectSnapshot: {
        clubRate: 0,
      },
      dispatches: [
        {
          id: 201,
          round: 1,
          status: DispatchStatus.ARCHIVED,
          archivedAt: new Date('2026-06-27T09:00:00.000Z'),
          participants: [],
        },
        {
          id: 202,
          round: 2,
          status: DispatchStatus.COMPLETED,
          completedAt: new Date('2026-06-27T10:00:00.000Z'),
          participants: [
            {
              id: 2002,
              userId: 3002,
              isActive: false,
              acceptedAt: new Date('2026-06-27T09:30:00.000Z'),
              rejectedAt: null,
              user: { name: '最终结单打手' },
            },
          ],
        },
      ],
    });

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      dispatchId: 202,
      userId: 3002,
      finalEarnings: 100,
    });
  });

  it('skips empty archived rounds for mode-play settlement rebuilds', () => {
    const settlements = computeBillingMODEPLAY(
      {
        id: 30,
        status: 'COMPLETED_PENDING_CONFIRM',
        paidAmount: 88,
        billingMode: BillingMode.MODE_PLAY,
        projectSnapshot: {
          clubRate: 0,
        },
        dispatches: [
          {
            id: 301,
            round: 1,
            status: DispatchStatus.ARCHIVED,
            archivedAt: new Date('2026-06-27T09:00:00.000Z'),
            participants: [],
          },
          {
            id: 302,
            round: 2,
            status: DispatchStatus.COMPLETED,
            completedAt: new Date('2026-06-27T10:00:00.000Z'),
            participants: [
              {
                id: 3002,
                userId: 4002,
                isActive: false,
                acceptedAt: new Date('2026-06-27T09:30:00.000Z'),
                rejectedAt: null,
                user: { name: '最终结单打手' },
              },
            ],
          },
        ],
      },
      [
        { dispatchId: 301, income: 0 },
        { dispatchId: 302, income: 88 },
      ],
    );

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      dispatchId: 302,
      userId: 4002,
      finalEarnings: 88,
    });
  });

  it('applies to guaranteed settlement rebuilds as well', () => {
    const settlements = computeBillingGuaranteed({
      id: 2,
      status: 'COMPLETED_PENDING_CONFIRM',
      baseAmountWan: 100,
      paidAmount: 100,
      billingMode: BillingMode.GUARANTEED,
      projectSnapshot: {
        clubRate: 0,
      },
      dispatches: [
        {
          id: 21,
          round: 1,
          status: DispatchStatus.COMPLETED,
          completedAt: new Date('2026-06-27T10:00:00.000Z'),
          participants: finalizedParticipants,
        },
      ],
    });

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      dispatchId: 21,
      userId: 1002,
      finalEarnings: 100,
    });
  });

  it('applies to mode-play settlement rebuilds as well', () => {
    const settlements = computeBillingMODEPLAY(
      {
        id: 3,
        status: 'COMPLETED_PENDING_CONFIRM',
        paidAmount: 88,
        billingMode: BillingMode.MODE_PLAY,
        projectSnapshot: {
          clubRate: 0,
        },
        dispatches: [
          {
            id: 31,
            round: 1,
            status: DispatchStatus.COMPLETED,
            completedAt: new Date('2026-06-27T10:00:00.000Z'),
            participants: finalizedParticipants,
          },
        ],
      },
      [{ dispatchId: 31, income: 88 }],
    );

    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      dispatchId: 31,
      userId: 1002,
      finalEarnings: 88,
    });
  });
});
