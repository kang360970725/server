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
});
