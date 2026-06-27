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
