import { receiptRange, reconcileReceipts, ReceiptItem, shanghaiReceiptDay } from './receipt-reconciliation';
import { FinanceService } from './finance.service';
import { recordOrderSupplementTx } from './order-receipts.util';

const receipt = (extra: Partial<ReceiptItem> = {}): ReceiptItem => ({ receiptId: 'ORDER:1', kind: 'INITIAL',
  orderId: 1, autoSerial: 'TEST-1', paymentTime: '2026-08-30T16:01:00Z', paidAmount: 100,
  channel: 'MANUAL_SHOUQIANBA', orderSource: 'CUSTOMER_SERVICE_MANUAL', dispatcherId: 7, dispatcherName: '客服', ...extra });

describe('收款日统计', () => {
  it('北京时间半开区间，拒绝无效日期与倒序', () => {
    const range = receiptRange({ startDate: '2026-08-31', endDate: '2026-08-31' });
    expect(range.startAt.toISOString()).toBe('2026-08-30T16:00:00.000Z');
    expect(range.endAt.toISOString()).toBe('2026-08-31T16:00:00.000Z');
    expect(shanghaiReceiptDay('2026-08-31T16:00:00Z')).toBe('2026-09-01');
    for (const startDate of ['2026-02-30', '2026-8-1', 'wrong', '2026-09-01']) {
      expect(() => receiptRange({ startDate, endDate: '2026-08-31' })).toThrow();
    }
  });
  it('跨天补收只进入补收日，区间订单去重、金额可逐日相加', () => {
    const result = reconcileReceipts([receipt({ paymentTime: '2026-08-30T15:59:59Z' }),
      receipt({ receiptId: 'SUPPLEMENT:1:15000', kind: 'SUPPLEMENT', paidAmount: 50 })]);
    expect(result.rows.map(r => [r.axis, r.allPaidAmountTotal])).toEqual([['2026-08-30', 100], ['2026-08-31', 50]]);
    expect(result.summary.allOrderCount).toBe(1);
    expect(result.summary.allPaidAmountTotal).toBe(150);
  });
  it('外部订单收钱吧、储值不重复收入、小程序和会员充值均有明细', () => {
    const result = reconcileReceipts([
      receipt({ orderId: 1, paidAmount: 200, orderSource: 'THIRD_PARTY_CHANNEL' }),
      receipt({ orderId: 2, paidAmount: 100, channel: 'BALANCE' }),
      receipt({ orderId: 3, paidAmount: 30, orderSource: 'MINIAPP_SELF_SERVICE', channel: 'MINIAPP_WECHAT' }),
      receipt({ kind: 'RECHARGE', orderId: undefined, paidAmount: 50, channel: 'MANUAL' }),
      receipt({ kind: 'RECHARGE', orderId: undefined, paidAmount: 70, channel: 'WECHAT' }),
    ]);
    expect(result.summary).toMatchObject({ allOrderCount: 3, allPaidAmountTotal: 350, orderCashAmountTotal: 230,
      orderPaidAmountTotal: 330, memberBalanceAmountTotal: 100, rechargeAmountTotal: 120, rechargeCount: 2,
      manualReceiptAmountTotal: 250, manualReceiptOrderCount: 1 });
    expect(result.rows[0].allPaidAmountTotal).toBe(result.summary.allPaidAmountTotal);
    expect(result.rows[0].detailRows).toHaveLength(5);
    expect(result.rows[0].dispatcherItems[0].paidAmountTotal).toBe(200);
    expect(result.rows[0].detailRows.find(r => r.channel === 'BALANCE').cashAmount).toBe(0);
  });
  it('充值独立成日，分单位聚合避免浮点误差', () => {
    const result = reconcileReceipts([receipt({ kind: 'RECHARGE', orderId: undefined, paidAmount: 0.1, channel: 'MANUAL' }),
      receipt({ kind: 'RECHARGE', orderId: undefined, paidAmount: 0.2, channel: 'MANUAL' })]);
    expect(result.summary.allPaidAmountTotal).toBe(0.3);
    expect(result.rows[0].allOrderCount).toBe(0);
    expect(result.rows[0].rechargeCount).toBe(2);
    expect(reconcileReceipts([]).rows).toEqual([]);
  });
});

describe('FinanceService 收款数据读取', () => {
  it('历史订单兼容、快照不重复累计、充值只用实付不计赠送', async () => {
    const tx: any = {
      order: { findMany: jest.fn().mockResolvedValue([
        { id: 1, autoSerial: 'OLD-1', paidAmount: 150, paymentTime: new Date('2026-08-30T16:01:00Z') },
        { id: 2, autoSerial: 'OLD-2', paidAmount: 40, paymentTime: new Date('2026-08-30T16:01:00Z') },
      ]) },
      orderReceipt: { findMany: jest.fn().mockResolvedValueOnce([
        { receiptKey: 'INITIAL:1', kind: 'INITIAL', orderId: 1, autoSerial: 'OLD-1', amount: 100,
          paidAt: new Date('2026-08-30T16:01:00Z'), channel: 'MANUAL_SHOUQIANBA', orderSource: 'TUTU_PLATFORM' },
      ]).mockResolvedValueOnce([{ orderId: 1 }]) },
      memberRechargeOrder: { findMany: jest.fn().mockResolvedValue([
        { id: 1, rechargeNo: 'R1', payAmount: 200, bonusAmount: 50, grantedAmount: 250,
          channel: 'MANUAL', paidAt: new Date('2026-08-30T16:02:00Z') },
        { id: 2, rechargeNo: 'R2', payAmount: 100, channel: 'WECHAT',
          notifyRaw: { amount: { total: 1 } }, paidAt: new Date('2026-08-30T16:02:00Z') },
      ]) },
    };
    const service = new FinanceService({ $transaction: (fn: any) => fn(tx) } as any);
    const result = await service.dashboardReconciliation({ startDate: '2026-08-31', endDate: '2026-08-31' });
    expect(result.data.summary).toMatchObject({ allPaidAmountTotal: 340.01, rechargeAmountTotal: 200.01,
      orderCashAmountTotal: 140, manualReceiptAmountTotal: 340 });
    const window = { gte: new Date('2026-08-30T16:00:00Z'), lt: new Date('2026-08-31T16:00:00Z') };
    expect(tx.order.findMany.mock.calls[0][0].where).toEqual({ isPaid: true, isGifted: false, paymentTime: window });
    expect(tx.memberRechargeOrder.findMany.mock.calls[0][0].where).toEqual({ status: 'SUCCESS', paidAt: window });
    expect(tx.orderReceipt.findMany.mock.calls[0][0].where).toEqual({ paidAt: window });
  });
});

describe('补收流水', () => {
  const before = { id: 1, autoSerial: 'TEST-1', paidAmount: 100, paymentTime: new Date('2026-08-30T00:00:00Z'),
    dispatcherId: 7, latestPaymentId: 2, orderSource: 'CUSTOMER_SERVICE_MANUAL' };
  function mockTx() { return { user: { findUnique: jest.fn().mockResolvedValue({ name: '客服', userType: 'CUSTOMER_SERVICE' }) },
    orderPayment: { findUnique: jest.fn().mockResolvedValue({ channel: 'BALANCE' }) },
    orderReceipt: { upsert: jest.fn(), create: jest.fn() } }; }
  it('保留首次储值渠道和日期，新增当天现金差额，不更新历史快照', async () => {
    const tx = mockTx(), now = new Date('2026-08-31T00:00:00Z');
    await recordOrderSupplementTx(tx, before, 150, 7, now);
    expect(tx.orderReceipt.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {},
      create: expect.objectContaining({ amount: 100, paidAt: before.paymentTime, channel: 'BALANCE' }) }));
    expect(tx.orderReceipt.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 50, paidAt: now,
      receiptKey: 'SUPPLEMENT:1:15000', channel: 'MANUAL_SHOUQIANBA' }) });
  });
  it('重复金额不写流水，缺失首次日期不臆测', async () => {
    const tx = mockTx();
    await recordOrderSupplementTx(tx, before, 100, 7, new Date());
    expect(tx.orderReceipt.create).not.toHaveBeenCalled();
    await expect(recordOrderSupplementTx(tx, { ...before, paymentTime: null }, 150, 7, new Date())).rejects.toThrow('缺少首次付款时间');
  });
});
