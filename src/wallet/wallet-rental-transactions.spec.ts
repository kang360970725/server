import { WalletService } from './wallet.service';

function fixture(rows: any[]) {
  const prisma: any = {
    walletAccount: { findUnique: jest.fn().mockResolvedValue({ availableBalance: 500, frozenBalance: 1000 }) },
    walletTransaction: { count: jest.fn().mockResolvedValue(rows.length), findMany: jest.fn().mockResolvedValue(rows) },
    order: { findMany: jest.fn().mockResolvedValue([{ id: 9, autoSerial: 'NORMAL-9' }]) },
    rentalOrder: { findMany: jest.fn().mockResolvedValue([{ id: 9, serialNo: 'LMSH12345678' }]) },
    $transaction: (queries: any[]) => Promise.all(queries),
  };
  const service = new WalletService(prisma);
  jest.spyOn(service as any, 'ensureWalletAccount').mockResolvedValue(undefined);
  return { prisma, service };
}

describe('Wallet rental transaction references', () => {
  it.each([
    ['RENTAL_ORDER_PREPAY', 'OUT', -100], ['RENTAL_ORDER_DEPOSIT', 'OUT', -100],
    ['RENTAL_ORDER_REFUND', 'IN', 100], ['RENTAL_ORDER_EXCESS_CHARGE', 'OUT', -100],
    ['RENTAL_ORDER_VOID_REFUND', 'IN', 100],
  ])('resolves existing %s rows and keeps normal orders separate', async (bizType, direction, delta) => {
    const f = fixture([
      { id: 2, sourceId: 9, sourceType: bizType, bizType, direction, amount: 100, status: 'AVAILABLE', availableAfter: 500, frozenAfter: 1000 },
      { id: 1, sourceId: 9, sourceType: 'OTHER', orderId: 9, bizType: 'OTHER', status: 'AVAILABLE' },
    ]);
    const result = await f.service.listMyTransactions(7, { includeReleaseFrozen: true } as any);
    expect(result.data[0]).toMatchObject({ orderAutoSerial: 'LMSH12345678', deltaAvailable: delta, availableBefore: 500 - Number(delta) });
    expect(result.data[1].orderAutoSerial).toBe('NORMAL-9');
    expect(f.prisma.rentalOrder.findMany).toHaveBeenCalledWith({ where: { id: { in: [9] }, staffUserId: 7 }, select: { id: true, serialNo: true } });
  });
  it('searches both order domains while preserving user and explicit order filters', async () => {
    const f = fixture([]);
    await f.service.listMyTransactions(7, { orderAutoSerial: 'LMSH123', orderId: 99, includeReleaseFrozen: true } as any);
    expect(f.prisma.walletTransaction.findMany.mock.calls[0][0].where).toEqual({
      userId: 7, orderId: 99, OR: [{ orderId: { in: [9] } },
        { sourceType: { in: expect.arrayContaining(['RENTAL_ORDER_VOID_REFUND']) }, sourceId: { in: [9] } }],
    });
    expect(f.prisma.rentalOrder.findMany).toHaveBeenCalledWith({ where: { staffUserId: 7, serialNo: { contains: 'LMSH123' } }, select: { id: true } });
  });
  it('does not substitute ordinary order numbers for missing rental sources', async () => {
    const f = fixture([{ id: 1, sourceId: 10, sourceType: 'RENTAL_ORDER_PREPAY', orderId: 9, bizType: 'RENTAL_ORDER_PREPAY' }]);
    f.prisma.rentalOrder.findMany.mockResolvedValue([]);
    expect((await f.service.listMyTransactions(7, { includeReleaseFrozen: true } as any)).data[0].orderAutoSerial).toBeNull();
  });
});
