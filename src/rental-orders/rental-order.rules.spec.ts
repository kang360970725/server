import { dateOnly, money, settleAmounts, startDateFor, todayRange } from './rental-order.rules';

const input = (v: any = {}) => ({ noRefundDifference: true, hasAbnormalCompensation: false, ownerSettlementAmount: 800, ...v });
describe('rental order rules', () => {
  it.each([
    ['2026-08-31T05:59:59.999Z', '2026-08-31'],
    ['2026-08-31T06:00:00.000Z', '2026-08-31'],
    ['2026-08-31T06:00:00.001Z', '2026-09-01'],
    ['2026-12-31T15:59:59.999Z', '2027-01-01'],
    ['2026-08-31T16:00:00.000Z', '2026-09-01'],
  ])('start date at %s is %s regardless of host timezone', (now, date) => {
    expect(startDateFor(new Date(now)).toISOString().slice(0, 10)).toBe(date);
  });
  it('uses Shanghai midnight and half-open daily statistics', () => {
    expect(todayRange(new Date('2026-08-31T20:00:00Z'))).toEqual({ gte: new Date('2026-08-31T16:00:00Z'), lt: new Date('2026-09-01T16:00:00Z') });
  });
  it.each(['2026-02-30', '2026-13-01', '2026-8-1', '', 'abc'])('rejects invalid date %s', (v) => expect(() => dateOnly(v, '日期')).toThrow());
  it.each([-1, 1.001, NaN, Infinity, true, '', null, 100000000])('rejects invalid money %s', (v) => expect(() => money(v, '金额')).toThrow());
  it('accepts cents without float drift', () => expect(money(0.29, '金额')).toBe(0.29));
  it.each([
    [0, 0, 0, 1000, 300], [0, 120, 0, 1120, 180], [0, 120, 250, 1370, -70],
    [100, 120, 0, 1020, 280], [0, 300, 0, 1300, 0], [1000, 0, 0, 0, 1300],
  ])('settles refund=%s loss=%s compensation=%s', (refund, loss, compensation, actual, net) => {
    const result = settleAmounts({ prepaidAmount: 1000, depositAmount: 300 }, input({
      noRefundDifference: refund === 0, refundDifferenceAmount: refund, refundDifferenceRemark: '退款说明',
      lossAmount: loss, lossDetail: '损耗明细', hasAbnormalCompensation: compensation > 0,
      abnormalCompensationAmount: compensation, abnormalCompensationRemark: '赔付规则',
    }));
    expect(result.actualAmount).toBe(actual); expect(result.settlementNetRefund).toBe(net);
  });
  it.each([
    { noRefundDifference: 'true' }, { refundDifferenceAmount: 1 },
    { abnormalCompensationAmount: 1 }, { lossAmount: 1 },
    { hasAbnormalCompensation: true, abnormalCompensationAmount: 10 },
    { noRefundDifference: false, refundDifferenceAmount: 10 },
    { noRefundDifference: false, refundDifferenceAmount: 1001, refundDifferenceRemark: '退款' },
    { ownerSettlementAmount: undefined },
  ])('rejects invalid settlement %j', (v) => expect(() => settleAmounts({ prepaidAmount: 1000, depositAmount: 300 }, input(v))).toThrow());
});
