import { StaffEmploymentStatus } from '@prisma/client';
import { WalletWithdrawalsService } from './wallet-withdrawals.service';

describe('WalletWithdrawalsService.applyWithdrawal', () => {
  const createService = (prisma: any, tx: any, staffRuleEngineService: any) => {
    const walletService = {
      ensureWalletAccountBucketsReady: jest.fn().mockResolvedValue(undefined),
      applyWalletAccountDelta: jest.fn().mockResolvedValue({
        availableBalance: 0,
        frozenBalance: 500,
        withdrawFrozenBalance: 500,
      }),
    } as any;
    const offlineFeeService = {
      getWithdrawalObligationTx: jest.fn().mockResolvedValue({ outstanding: 0 }),
    } as any;
    const systemConfigService = {
      getBoolean: jest.fn().mockResolvedValue(false),
      getNumber: jest.fn().mockResolvedValue(0),
      getString: jest.fn().mockResolvedValue(''),
    } as any;
    const wechatTransferService = {
      getConfigStatus: jest.fn().mockResolvedValue({ ready: false }),
    } as any;

    return {
      service: new WalletWithdrawalsService(
        prisma,
        walletService,
        {} as any,
        offlineFeeService,
        staffRuleEngineService,
        systemConfigService,
        wechatTransferService,
      ),
      walletService,
      offlineFeeService,
    };
  };

  it.each([
    [20, 0, 1000, '首次提现需接单满20单，当前已接0单', 0],
    [20, 19, 1000, '首次提现需接单满20单，当前已接19单', 0],
    [3, 2, 1000, '首次提现需接单满3单，当前已接2单', 0],
    [20, 20, 999, '首次提现余额需达到 1000', 0],
    [20, 20, 1000, '可用余额不足', 0],
    [20, 21, 1000, '可用余额不足', 0],
    [0, 0, 1000, '可用余额不足', 0],
    [20, 20, 1000, '', 0],
    [20, 21, 1000, '', 0],
    [3, 3, 1000, '', 0],
    [0, 0, 1000, '', 0],
    [20, 0, 500, '', 1],
  ])('checks threshold %s, orders %s, balance %s, error "%s", history %s', async (threshold, count, balance, expectedError, history) => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 9,
            userType: 'STAFF',
            createdAt: new Date(),
            staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
            staffDormantFreezeBaseAt: null,
            Role: { name: 'staff' },
          })
          .mockResolvedValueOnce({
            withdrawQrCodeKey: 'cloud://qr-code',
            canWithdraw: true,
            staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
            userType: 'STAFF',
            depositLimit: 2000,
            staffTags: ['new_staff'],
            workMode: 'ONLINE',
          }),
      },
      walletWithdrawalRequest: {
        count: jest
          .fn()
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(0)
          .mockResolvedValueOnce(history),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: 31, ...data })),
      },
      orderParticipant: {
        findFirst: jest.fn().mockResolvedValue({ acceptedAt: twoDaysAgo }),
      },
      order: { count: jest.fn().mockResolvedValue(count) },
      walletAccount: {
        findUnique: jest.fn().mockResolvedValue({ availableBalance: balance, depositBalance: 500 }),
      },
      walletTransaction: {
        create: jest.fn().mockResolvedValue({ id: 91 }),
        update: jest.fn().mockResolvedValue({ id: 91 }),
      },
    };

    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const staffRuleEngineService = {
      getConfig: jest.fn().mockResolvedValue({ tags: [], rules: [], defaultRule: { dormantFreezeDays: 7 } }),
      resolveMatchedRule: jest.fn().mockReturnValue({
        firstWithdrawMinBalance: 1000,
        firstWithdrawMinAcceptedOrders: threshold,
        depositAmount: 500,
        dormantFreezeDays: 7,
      }),
      getDormantFreezeDays: jest.fn().mockReturnValue(7),
      buildDormantFreezeMessage: jest.fn((days: number) => `用户活跃度太低，已经超过${days}天，账号已自动冻结，请联系管理超哥进行处理。`),
    } as any;
    const { service, walletService } = createService(prisma, tx, staffRuleEngineService);

    const withdrawal = service.applyWithdrawal({
      userId: 9,
      amount: expectedError ? 1100 : 500,
      idempotencyKey: 'first-withdraw-orders-1',
    });
    if (expectedError) {
      await expect(withdrawal).rejects.toThrow(expectedError);
      expect(walletService.applyWalletAccountDelta).not.toHaveBeenCalled();
      expect(tx.walletWithdrawalRequest.create).not.toHaveBeenCalled();
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    } else {
      await expect(withdrawal).resolves.toMatchObject({
        userId: 9, amount: 500, status: 'PENDING_REVIEW', reserveTxId: 91,
      });
      expect(walletService.applyWalletAccountDelta).toHaveBeenCalledTimes(1);
      expect(walletService.applyWalletAccountDelta).toHaveBeenCalledWith(tx, 9, {
        availableDelta: -500, depositDelta: 0, withdrawFrozenDelta: 500,
      });
      expect(tx.walletTransaction.create).toHaveBeenCalledTimes(1);
      expect(tx.walletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ bizType: 'WITHDRAW_RESERVE', amount: 500 }),
      }));
      expect(tx.walletTransaction.update).toHaveBeenCalledWith({
        where: { id: 91 }, data: { sourceId: 31 },
      });
    }
    if (history) {
      expect(tx.order.count).not.toHaveBeenCalled();
      return;
    }
    expect(tx.order.count).toHaveBeenCalledWith({
      where: {
        status: { notIn: ['CANCELLED', 'REFUNDED'] },
        dispatches: { some: { participants: { some: {
          userId: 9, acceptedAt: { not: null }, rejectedAt: null,
        } } } },
      },
    });
  });

  it('does not auto deduct deposit for exited staff withdrawal', async () => {
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 7,
            userType: 'STAFF',
            createdAt: new Date(),
            staffEmploymentStatus: StaffEmploymentStatus.EXITED,
            staffDormantFreezeBaseAt: null,
            Role: { name: 'staff' },
          })
          .mockResolvedValueOnce({
            withdrawQrCodeKey: 'cloud://qr-code',
            canWithdraw: false,
            staffEmploymentStatus: StaffEmploymentStatus.EXITED,
            userType: 'STAFF',
            depositLimit: 2000,
            staffTags: [],
            workMode: 'ONLINE',
          }),
      },
      walletWithdrawalRequest: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 31,
          userId: 7,
          amount: 500,
          status: 'PENDING_REVIEW',
        }),
      },
      orderParticipant: {
        findFirst: jest.fn(),
      },
      walletAccount: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ userId: 7, availableBalance: 500, depositBalance: 0 })
          .mockResolvedValueOnce({ userId: 7, availableBalance: 500, depositBalance: 0 }),
      },
      walletDepositTransaction: {
        create: jest.fn(),
      },
      walletTransaction: {
        create: jest.fn().mockResolvedValue({ id: 91 }),
        update: jest.fn(),
      },
    };

    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const staffRuleEngineService = {
      getConfig: jest.fn(),
      resolveMatchedRule: jest.fn(),
      getDormantFreezeDays: jest.fn().mockReturnValue(7),
      buildDormantFreezeMessage: jest.fn((days: number) => `用户活跃度太低，已经超过${days}天，账号已自动冻结，请联系管理超哥进行处理。`),
    } as any;
    const { service, walletService } = createService(prisma, tx, staffRuleEngineService);

    const result = await service.applyWithdrawal({
      userId: 7,
      amount: 500,
      idempotencyKey: 'exit-withdraw-1',
    });

    expect(result.amount).toBe(500);
    expect(tx.orderParticipant.findFirst).not.toHaveBeenCalled();
    expect(staffRuleEngineService.resolveMatchedRule).not.toHaveBeenCalled();
    expect(tx.walletDepositTransaction.create).not.toHaveBeenCalled();
    expect(walletService.applyWalletAccountDelta).toHaveBeenCalledWith(tx, 7, {
      availableDelta: -500,
      depositDelta: 0,
      withdrawFrozenDelta: 500,
    });
    expect(tx.walletWithdrawalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 7,
          amount: 500,
        }),
      }),
    );
  });
});

describe('WalletWithdrawalsService.reviewWithdrawal', () => {
  const createService = (prisma: any, staffRuleEngineService: any = {}) => {
    const walletService = {
      ensureWalletAccountBucketsReady: jest.fn().mockResolvedValue(undefined),
      applyWalletAccountDelta: jest.fn(),
    } as any;
    const offlineFeeService = {
      getWithdrawalObligationTx: jest.fn().mockResolvedValue({ outstanding: 0 }),
    } as any;
    const systemConfigService = {
      getBoolean: jest.fn().mockResolvedValue(false),
      getNumber: jest.fn().mockResolvedValue(0),
      getString: jest.fn().mockResolvedValue(''),
    } as any;
    const wechatTransferService = {
      getConfigStatus: jest.fn().mockResolvedValue({ ready: false }),
    } as any;

    return {
      service: new WalletWithdrawalsService(
        prisma,
        walletService,
        {} as any,
        offlineFeeService,
        staffRuleEngineService,
        systemConfigService,
        wechatTransferService,
      ),
      walletService,
    };
  };

  it.each([
    [-700, 800, true], [-1000, 800, true], [-1000.01, 800, false], [-700, 799, false],
  ])('reviews pre-reserved withdrawal with available=%s reserve=%s allowed=%s', async (available, reserved, allowed) => {
    const request = { id: 12, userId: 7, amount: 800, status: 'PENDING_REVIEW', reserveTxId: 90,
      reserveTx: { userId: 7, sourceId: 12, amount: 800, status: 'FROZEN', direction: 'OUT', bizType: 'WITHDRAW_RESERVE' } };
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      walletAccount: { findUnique: jest.fn().mockResolvedValue({ availableBalance: available, earningFrozenBalance: 1000,
        withdrawFrozenBalance: reserved, frozenBalance: 1000 + reserved, depositBalance: 9000 }) },
      walletHold: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 1000 } }), count: jest.fn().mockResolvedValue(0) },
      walletWithdrawalRequest: {
        findUnique: jest.fn().mockResolvedValue(request), findMany: jest.fn().mockResolvedValue([request]),
        update: jest.fn().mockImplementation(async ({ data }) => ({ ...request, ...data })),
      },
      walletTransaction: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({ id: 91 }) },
    };
    const { service, walletService } = createService({ $transaction: (fn: any) => fn(tx) });
    walletService.applyWalletAccountDelta.mockResolvedValue({ availableBalance: available, frozenBalance: 1000, earningFrozenBalance: 1000, withdrawFrozenBalance: 0 });
    const result = service.reviewWithdrawal({ requestId: 12, reviewerId: 3, approve: true });
    if (allowed) {
      await expect(result).resolves.toMatchObject({ status: 'PAID', payoutTxId: 91 });
      expect(walletService.applyWalletAccountDelta).toHaveBeenCalledWith(tx, 7, { withdrawFrozenDelta: -800 });
      expect(tx.walletTransaction.upsert).toHaveBeenCalledTimes(1);
    } else {
      await expect(result).rejects.toThrow();
      expect(walletService.applyWalletAccountDelta).not.toHaveBeenCalled();
      expect(tx.walletWithdrawalRequest.update).not.toHaveBeenCalled();
    }
  });

  it('allows rejecting a withdrawal when release only partially offsets a negative available balance', async () => {
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      walletWithdrawalRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 12,
          userId: 7,
          amount: 500,
          status: 'PENDING_REVIEW',
        }),
        update: jest.fn().mockResolvedValue({
          id: 12,
          userId: 7,
          amount: 500,
          status: 'REJECTED',
        }),
      },
      walletTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 91 }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const { service, walletService } = createService(prisma);

    walletService.applyWalletAccountDelta.mockResolvedValue({
      availableBalance: -300,
      frozenBalance: 0,
      withdrawFrozenBalance: 0,
    });

    const result = await service.reviewWithdrawal({
      requestId: 12,
      reviewerId: 3,
      approve: false,
      reviewRemark: '余额为负，驳回提现用于冲抵欠款',
    });

    expect(result.status).toBe('REJECTED');
    expect(walletService.applyWalletAccountDelta).toHaveBeenCalledWith(tx, 7, {
      withdrawFrozenDelta: -500,
      availableDelta: 500,
    });
    expect(tx.walletTransaction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          bizType: 'WITHDRAW_RELEASE',
          amount: 500,
          availableAfter: -300,
          frozenAfter: 0,
        }),
      }),
    );
  });
});
