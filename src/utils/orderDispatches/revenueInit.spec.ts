import { BillingMode, DispatchStatus } from '@prisma/client';
import {
  computeBillingGuaranteed,
  computeBillingHours,
  computeBillingMODEPLAY,
} from './revenueInit';

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
