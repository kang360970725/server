import { MiniOrdersController } from './mini-orders.controller';

describe('小程序订单付款日', () => {
  it.each([1, null])('支付回调 %s 分支保留实际成功时间', async (id) => {
    const tx = { order: { findUnique: jest.fn().mockResolvedValue({ isTestPayment: false }), update: jest.fn() },
      orderPayment: { update: jest.fn().mockResolvedValue({ id: 1 }), upsert: jest.fn().mockResolvedValue({ id: 1 }) } };
    const controller: any = new MiniOrdersController({ $transaction: (fn: any) => fn(tx) } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, { pushOrderProgressMessage: jest.fn() } as any);
    await controller.applyWechatPaymentSuccess(1, { id, orderId: 1 }, {
      success_time: '2026-08-30T23:59:00+08:00', amount: { payer_total: 10000 }, out_trade_no: 'WX1',
    });
    const expected = new Date('2026-08-30T15:59:00Z');
    expect(tx.order.update.mock.calls[0][0].data.paymentTime).toEqual(expected);
    if (id) expect(tx.orderPayment.update.mock.calls[0][0].data.paidAt).toEqual(expected);
    else {
      expect(tx.orderPayment.upsert.mock.calls[0][0].create.paidAt).toEqual(expected);
      expect(tx.orderPayment.upsert.mock.calls[0][0].update.paidAt).toEqual(expected);
    }
  });
});
