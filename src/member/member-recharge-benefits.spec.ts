import { normalizeRechargeCouponBenefits } from './member-recharge-benefits';

describe('member recharge coupon benefits', () => {
  it('keeps the configured quantity for one coupon template', () => {
    expect(normalizeRechargeCouponBenefits([{ templateId: 3, count: 5 }]))
      .toEqual([{ templateId: 3, count: 5 }]);
  });

  it('merges duplicate template rows instead of dropping coupon quantities', () => {
    expect(normalizeRechargeCouponBenefits([
      { templateId: 3, count: 2 },
      { templateId: 3, count: 4 },
      { templateId: 5, count: 1 },
    ])).toEqual([
      { templateId: 3, count: 6 },
      { templateId: 5, count: 1 },
    ]);
  });
});
