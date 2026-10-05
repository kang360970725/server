import { OrdersService } from './orders.service';

describe('OrdersService reserved balance refund guards', () => {
  const createService = () => {
    const service = Object.create(OrdersService.prototype) as OrdersService;
    (service as any).prisma = {
      orderPayment: { create: jest.fn() },
      order: { update: jest.fn() },
    };
    return service;
  };

  it('never synthesizes a legacy payment for a reserve-capture order', async () => {
    const service = createService();
    const order = {
      id: 12572,
      isPaid: true,
      payStatus: 'PENDING',
      balanceSettlementMode: 'RESERVE_CAPTURE',
      latestPayment: { id: 5721, channel: 'BALANCE', status: 'PENDING', amount: 1508.6 },
    };

    await expect((service as any).ensureLegacySuccessfulPaymentForRefund(order)).resolves.toBe(order);
    expect((service as any).prisma.orderPayment.create).not.toHaveBeenCalled();
    expect((service as any).prisma.order.update).not.toHaveBeenCalled();
  });

  it('releases held balance and lot allocations exactly once', async () => {
    const service = createService();
    const tx = {
      memberOrderBalanceReservation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 2,
          orderId: 12572,
          userId: 694,
          reservedAmount: 1508.6,
          status: 'HELD',
          lots: [
            { id: 2, lotId: 1, principalReserved: 870.6, bonusReserved: 638 },
          ],
        }),
        update: jest.fn(),
      },
      memberBalanceLot: { update: jest.fn() },
      walletAccount: { update: jest.fn() },
      orderPayment: { updateMany: jest.fn() },
      order: { update: jest.fn() },
      $queryRawUnsafe: jest.fn(),
    };

    await expect(
      (service as any).releaseMemberBalanceReservationTx(tx, 12572, '订单退款'),
    ).resolves.toEqual({ releasedAmount: 1508.6 });

    expect(tx.memberBalanceLot.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: {
        principalRemaining: { increment: 870.6 },
        bonusRemaining: { increment: 638 },
        status: 'ACTIVE',
      },
    });
    expect(tx.walletAccount.update).toHaveBeenCalledWith({
      where: { userId: 694 },
      data: {
        memberOrderReservedBalance: { decrement: 1508.6 },
        availableBalance: { increment: 1508.6 },
      },
    });
    expect(tx.memberOrderBalanceReservation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 2 },
        data: expect.objectContaining({ releasedAmount: 1508.6, status: 'RELEASED' }),
      }),
    );
    expect(tx.orderPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 12572, channel: 'BALANCE', status: 'PENDING' },
        data: expect.objectContaining({ status: 'CLOSED' }),
      }),
    );
  });
});
