import { MemberService } from './member.service';

describe('会员充值收款日期', () => {
  afterEach(() => jest.useRealTimers());
  it.each([
    ['WECHAT', '2026-08-30T23:59:00+08:00', '2026-08-30T15:59:00.000Z'],
    ['WECHAT', 'invalid', '2026-08-30T16:01:00.000Z'],
    ['MANUAL', '2026-08-30T23:59:00+08:00', '2026-08-30T16:01:00.000Z'],
  ])('%s 充值使用可信支付时间或人工操作时间', async (channel, success_time, expected) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-30T16:01:00Z'));
    const order = { id: 1, userId: 2, channel, status: 'PENDING', payAmount: 100, bonusAmount: 20, giftPoints: 0 };
    const tx = { memberRechargeOrder: { update: jest.fn().mockResolvedValue(order) },
      memberProfile: { findUnique: jest.fn().mockResolvedValue({}), update: jest.fn() } };
    const wallet = { creditAvailableBalance: jest.fn() };
    const service: any = new MemberService({ memberRechargeOrder: { findUnique: jest.fn().mockResolvedValue(order) },
      $transaction: (fn: any) => fn(tx) } as any, wallet as any, {} as any, {} as any);
    service.ensureUserAssets = jest.fn();
    service.resolveLevelConfig = jest.fn();
    await service.settleRechargeSuccess('R1', { notifyRaw: { success_time } });
    expect(tx.memberRechargeOrder.update.mock.calls[0][0].data.paidAt.toISOString()).toBe(expected);
    expect(wallet.creditAvailableBalance.mock.calls.map(c => c[0].amount)).toEqual([100, 20]);
  });
  it('已成功充值回调不改历史付款日期', async () => {
    const order = { status: 'SUCCESS', paidAt: new Date('2026-08-30T00:00:00Z') };
    const db = { memberRechargeOrder: { findUnique: jest.fn().mockResolvedValue(order) }, $transaction: jest.fn() };
    const service = new MemberService(db as any, {} as any, {} as any, {} as any);
    expect(await service.settleRechargeSuccess('R1', {})).toBe(order);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
