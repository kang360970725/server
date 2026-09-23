import { WalletDepositService } from './wallet.deposit.service';

describe('WalletDepositService manual deposit audit fields', () => {
  it('requires a structured source and a reason', async () => {
    const service = new WalletDepositService({} as any);

    await expect(service.manualDeposit({ userId: 7, amount: 500, remark: '线下微信到账' }))
      .rejects.toThrow('请选择保证金录入来源');
    await expect(service.manualDeposit({ userId: 7, amount: 500, manualSource: 'OFFLINE_PAYMENT', remark: '  ' }))
      .rejects.toThrow('请填写保证金录入原因');
  });

  it('persists the structured source and trimmed reason', async () => {
    const tx: any = {
      walletAccount: {
        update: jest.fn().mockResolvedValue({ availableBalance: 100, frozenBalance: 20 }),
      },
      walletDepositTransaction: {
        create: jest.fn().mockResolvedValue({ id: 19 }),
      },
      walletTransaction: { create: jest.fn() },
    };
    const service = new WalletDepositService({ $transaction: (fn: any) => fn(tx) } as any);

    await service.manualDeposit({
      userId: 7,
      amount: 500,
      manualSource: 'OFFLINE_PAYMENT',
      remark: '  微信收钱吧流水 SQB001  ',
      operatorId: 3,
    });

    expect(tx.walletDepositTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 7,
        amount: 500,
        manualSource: 'OFFLINE_PAYMENT',
        remark: '微信收钱吧流水 SQB001',
        operatorId: 3,
      }),
    });
  });

  it('refunds deposit to available balance and persists both audit flows', async () => {
    const tx: any = {
      $queryRawUnsafe: jest.fn(),
      walletAccount: {
        findUnique: jest.fn().mockResolvedValue({ depositBalance: 800, availableBalance: 100, frozenBalance: 20 }),
        update: jest.fn().mockResolvedValue({ depositBalance: 500, availableBalance: 400, frozenBalance: 20 }),
      },
      walletDepositTransaction: { create: jest.fn().mockResolvedValue({ id: 21 }) },
      walletTransaction: { create: jest.fn() },
    };
    const service = new WalletDepositService({ $transaction: (fn: any) => fn(tx) } as any);
    const result = await service.manualRefund({ userId: 7, amount: 300, remark: ' 重复录入退回 ', operatorId: 3 });

    expect(result).toMatchObject({ depositBalance: 500, availableBalance: 400, frozenBalance: 20 });
    expect(tx.walletAccount.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 7 },
      data: { depositBalance: { decrement: 300 }, availableBalance: { increment: 300 } },
    }));
    expect(tx.walletDepositTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: 7, amount: -300, bizType: 'DEPOSIT_REFUND', operatorId: 3, manualSource: 'MANUAL_REFUND', remark: '重复录入退回',
    }) });
    expect(tx.walletTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      direction: 'IN', bizType: 'DEPOSIT_REFUND', amount: 300, sourceId: 21, availableAfter: 400,
    }) });
  });

  it('does not allow a manual refund above the deposit balance', async () => {
    const tx: any = {
      $queryRawUnsafe: jest.fn(),
      walletAccount: { findUnique: jest.fn().mockResolvedValue({ depositBalance: 200, availableBalance: 100, frozenBalance: 0 }) },
    };
    const service = new WalletDepositService({ $transaction: (fn: any) => fn(tx) } as any);
    await expect(service.manualRefund({ userId: 7, amount: 201, remark: '退押', operatorId: 3 }))
      .rejects.toThrow('退还金额不能超过当前保证金余额');
  });
});
