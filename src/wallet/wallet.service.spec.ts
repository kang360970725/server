import { WalletService } from './wallet.service';

describe('WalletService.rollbackOrderWalletImpactInTxV2', () => {
  const prismaMock = {} as any;
  let service: WalletService;

  beforeEach(() => {
    service = new WalletService(prismaMock);
  });

  it('reverses released settlement earnings from available only', async () => {
    const tx = {
      walletTransaction: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: 101,
              userId: 1001,
              direction: 'IN',
              status: 'AVAILABLE',
              amount: 100,
              sourceId: 501,
              settlementId: 501,
              orderId: 9001,
              dispatchId: 3001,
              bizType: 'SETTLEMENT_EARNING_BASE',
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 201,
              userId: 1001,
              direction: 'IN',
              status: 'AVAILABLE',
              amount: 100,
              sourceId: 101,
              bizType: 'RELEASE_FROZEN',
            },
          ]),
      },
    } as any;

    const result = await service.rollbackOrderWalletImpactInTxV2({
      tx,
      settlementIds: [501],
      orderId: 9001,
    });

    expect(result.releaseTxCount).toBe(1);
    expect(result.reversalPlans).toHaveLength(1);
    expect(result.reversalPlans[0]).toMatchObject({
      kind: 'EARNING_TX_REVERSAL',
      userId: 1001,
      sourceTxId: 101,
      finalEarnings: -100,
      statusHint: 'AVAILABLE',
      sourceTypeOverride: 'ORDER_SETTLEMENT_REVERSAL',
    });
    expect(result.sourceSettlementStatusHints).toEqual([
      { settlementId: 501, statusHint: 'AVAILABLE' },
    ]);
  });

  it('keeps unreleased settlement earnings on frozen reversal', async () => {
    const tx = {
      walletTransaction: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: 102,
              userId: 1002,
              direction: 'IN',
              status: 'FROZEN',
              amount: 88,
              sourceId: 502,
              settlementId: 502,
              orderId: 9002,
              dispatchId: 3002,
              bizType: 'SETTLEMENT_EARNING_BASE',
            },
          ])
          .mockResolvedValueOnce([]),
      },
    } as any;

    const result = await service.rollbackOrderWalletImpactInTxV2({
      tx,
      settlementIds: [502],
      orderId: 9002,
    });

    expect(result.releaseTxCount).toBe(0);
    expect(result.reversalPlans).toHaveLength(1);
    expect(result.reversalPlans[0]).toMatchObject({
      kind: 'EARNING_TX_REVERSAL',
      userId: 1002,
      sourceTxId: 102,
      finalEarnings: -88,
      statusHint: 'FROZEN',
      sourceTypeOverride: 'ORDER_SETTLEMENT_REVERSAL',
    });
    expect(result.sourceSettlementStatusHints).toEqual([
      { settlementId: 502, statusHint: 'FROZEN' },
    ]);
  });
});

describe('WalletService.applySettlementEarningToWalletV2 hold lifecycle', () => {
  let service: WalletService;

  beforeEach(() => {
    service = new WalletService({} as any);
    (service as any).ensureWalletAccount = jest.fn().mockResolvedValue(undefined);
    (service as any).applyWalletAccountDelta = jest.fn().mockResolvedValue({
      availableBalance: 10,
      frozenBalance: 20,
      earningFrozenBalance: 20,
      withdrawFrozenBalance: 0,
    });
  });

  it('does not create a hold for a frozen OUT reversal and cancels the source hold', async () => {
    const tx = {
      walletTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 202 }),
        update: jest.fn().mockResolvedValue({}),
      },
      walletHold: {
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;

    const result = await service.applySettlementEarningToWalletV2({
      tx,
      userId: 610,
      settlementId: 35390,
      orderId: 11367,
      finalEarnings: -219.2,
      unlockAt: new Date(Date.now() + 86_400_000),
      statusHint: 'FROZEN',
      bizTypeOverride: 'SETTLEMENT_REVERSAL',
      sourceTypeOverride: 'ORDER_SETTLEMENT_REVERSAL',
      sourceIdOverride: 68956,
    });

    expect(result).toMatchObject({
      earningTxId: 202,
      direction: 'OUT',
      status: 'FROZEN',
      hold: null,
    });
    expect(tx.walletHold.upsert).not.toHaveBeenCalled();
    expect(tx.walletHold.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { earningTxId: 68956, status: 'FROZEN' },
      data: expect.objectContaining({ status: 'CANCELLED' }),
    }));
    expect((service as any).applyWalletAccountDelta).toHaveBeenCalledWith(
      tx,
      610,
      { availableDelta: 0, earningFrozenDelta: -219.2 },
    );
  });

  it('still creates a hold for a frozen positive recalculation', async () => {
    const tx = {
      walletTransaction: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 203 }),
        update: jest.fn().mockResolvedValue({}),
      },
      walletHold: {
        upsert: jest.fn().mockResolvedValue({ id: 303, status: 'FROZEN' }),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    } as any;

    const result = await service.applySettlementEarningToWalletV2({
      tx,
      userId: 610,
      settlementId: 35442,
      orderId: 11367,
      finalEarnings: 219.8,
      unlockAt: new Date(Date.now() + 86_400_000),
      statusHint: 'FROZEN',
      bizTypeOverride: 'SETTLEMENT_RECALC',
      sourceTypeOverride: 'ORDER_SETTLEMENT_RECALC',
      sourceIdOverride: 35442,
    });

    expect(result).toMatchObject({ direction: 'IN', status: 'FROZEN' });
    expect(tx.walletHold.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ earningTxId: 203, amount: 219.8, status: 'FROZEN' }),
    }));
    expect(tx.walletHold.updateMany).not.toHaveBeenCalled();
  });
});

describe('WalletService historical frozen hold cleanup', () => {
  it('cancels both an OUT reversal hold and the frozen source hold it reversed', async () => {
    const service = new WalletService({} as any);
    const tx = {
      walletHold: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 30147,
            earningTxId: 68956,
            earningTx: { userId: 610, direction: 'IN', status: 'FROZEN' },
          },
          {
            id: 30190,
            earningTxId: 69205,
            earningTx: { userId: 610, direction: 'OUT', status: 'FROZEN' },
          },
          {
            id: 30196,
            earningTxId: 69212,
            earningTx: { userId: 610, direction: 'IN', status: 'FROZEN' },
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      walletTransaction: {
        findMany: jest.fn().mockResolvedValue([
          { sourceId: 68956 },
        ]),
      },
    } as any;

    const ids = await (service as any).cancelInvalidFrozenHoldsTx(tx, 610);

    expect(ids).toEqual([30147, 30190]);
    expect(tx.walletHold.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: [30147, 30190] }, status: 'FROZEN' },
      data: expect.objectContaining({ status: 'CANCELLED' }),
    }));
  });
});
