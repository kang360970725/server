import { OrdersService } from './orders.service';

describe('OrdersService partial refund settlement policy', () => {
  const service = Object.create(OrdersService.prototype) as OrdersService;
  (service as any).systemConfigService = { getJson: jest.fn().mockResolvedValue(null) };
  const settlements = [
    { userId: 11, settlementType: 'REGULAR', calculatedEarnings: 80, finalEarnings: 80 },
    { userId: 12, settlementType: 'REGULAR', calculatedEarnings: 60, finalEarnings: 60 },
    { userId: 11, settlementType: 'CUSTOMER_SERVICE', calculatedEarnings: 2, finalEarnings: 2 },
  ];

  it('keeps all recalculated earnings when players are not liable', () => {
    const result = (service as any).applyPartialRefundLiabilityToSettlements(
      settlements,
      false,
      [11, 12],
      'PARTIAL_REFUND_LIABLE',
    );

    expect(result).toBe(settlements);
    expect(result.map((item: any) => item.finalEarnings)).toEqual([80, 60, 2]);
  });

  it('zeros liable player earnings but preserves non-liable and commission rows', () => {
    const result = (service as any).applyPartialRefundLiabilityToSettlements(
      settlements,
      true,
      [11],
      'PARTIAL_REFUND_LIABLE',
    );

    expect(result).toEqual([
      expect.objectContaining({ userId: 11, finalEarnings: 0, manualAdjustment: -80 }),
      expect.objectContaining({ userId: 12, finalEarnings: 60 }),
      expect.objectContaining({ userId: 11, settlementType: 'CUSTOMER_SERVICE', finalEarnings: 2 }),
    ]);
  });

  it('uses the remaining settlement amount for renewal commission after a refund', async () => {
    await expect(
      (service as any).resolveRenewalBonusRule({
        paidAmount: 288,
        settlementBaseAmount: 188,
        refunds: [{ amount: 100, refundType: 'PARTIAL', staffLiable: false }],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        baseAmountField: 'settlementBaseAmount',
        baseAmount: 188,
        rate: 0.01,
      }),
    );
  });
});
