import { OrdersService } from './orders.service';

describe('OrdersService Shouqianba preparation', () => {
  const service = new OrdersService(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any,
  );

  it('builds a unique provider-safe client_sn for each purpose and attempt', () => {
    const build = (service as any).buildShouqianbaClientSn.bind(service);
    const order = build(12345, 'ORDER', 1);
    const retry = build(12345, 'ORDER', 2);
    const supplement = build(12345, 'SUPPLEMENT', 1);

    expect(order.length).toBeGreaterThan(0);
    expect(order.length).toBeLessThanOrEqual(32);
    expect(new Set([order, retry, supplement]).size).toBe(3);
    expect(order).toMatch(/^[A-Z0-9]+$/);
  });

  it('uses final payable amount as the customer-service liability amount', () => {
    const amount = (service as any).getUnpaidLiabilityAmount({
      receivableAmount: 120,
      paidAmount: 100,
      finalPayableAmount: 88.66,
    });
    expect(amount).toBe(88.66);
  });
});
