import { OrdersController } from './orders.controller';

describe('OrdersController list', () => {
  it('forwards the month filter and normalized pagination to the service', async () => {
    const listOrders = jest.fn().mockResolvedValue({ data: [], total: 0 });
    const controller = new OrdersController({ listOrders } as any, {} as any);

    await controller.list({
      page: '2',
      limit: '50',
      orderMonth: ' 2026-08 ',
    });

    expect(listOrders).toHaveBeenCalledWith(expect.objectContaining({
      page: 2,
      limit: 50,
      orderMonth: '2026-08',
    }));
  });

  it('does not forward an empty month filter', async () => {
    const listOrders = jest.fn().mockResolvedValue({ data: [], total: 0 });
    const controller = new OrdersController({ listOrders } as any, {} as any);

    await controller.list({ orderMonth: '' });

    expect(listOrders).toHaveBeenCalledWith(expect.objectContaining({
      orderMonth: undefined,
    }));
  });
});
