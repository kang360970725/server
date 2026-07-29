import { StaffEmploymentStatus } from '@prisma/client';
import { WalletWithdrawalsService } from './wallet-withdrawals.service';

describe('WalletWithdrawalsService.applyWithdrawal', () => {
  const createService = (prisma: any, tx: any, staffRuleEngineService: any) => {
    const walletService = {
      ensureWalletAccountBucketsReady: jest.fn().mockResolvedValue(undefined),
      applyWalletAccountDelta: jest.fn().mockResolvedValue({
        availableBalance: 0,
        frozenBalance: 500,
      }),
    } as any;
    const offlineFeeService = {
      attachWithdrawalToPayment: jest.fn().mockResolvedValue(undefined),
      validateAndCollectForWithdrawalTx: jest.fn(),
    } as any;

    return {
      service: new WalletWithdrawalsService(
        prisma,
        walletService,
        {} as any,
        offlineFeeService,
        staffRuleEngineService,
      ),
      walletService,
      offlineFeeService,
    };
  };

  it('uses configured first withdrawal accepted-days threshold', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const tx: any = {
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
          .mockResolvedValueOnce(0),
      },
      orderParticipant: {
        findFirst: jest.fn().mockResolvedValue({ acceptedAt: twoDaysAgo }),
      },
      walletAccount: {
        findUnique: jest.fn(),
      },
    };

    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const staffRuleEngineService = {
      getConfig: jest.fn().mockResolvedValue({ tags: [], rules: [] }),
      resolveMatchedRule: jest.fn().mockReturnValue({
        firstWithdrawMinBalance: 100,
        firstWithdrawMinAcceptedDays: 3,
        depositAmount: 500,
      }),
    } as any;
    const { service } = createService(prisma, tx, staffRuleEngineService);

    await expect(service.applyWithdrawal({
      userId: 9,
      amount: 100,
      idempotencyKey: 'first-withdraw-days-1',
    })).rejects.toThrow('首次提现需接单满3天');
  });

  it('does not auto deduct deposit for exited staff withdrawal', async () => {
    const tx: any = {
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
