import { RentalOrdersService } from './rental-orders.service';

// 内存事务替身验证业务原子性/幂等路径；不替代真实MySQL行锁集成测试。
function fixture() {
  let state: any = { account: { availableBalance: 500, earningFrozenBalance: 1000, withdrawFrozenBalance: 0, frozenBalance: 1000 }, orders: [], transactions: [], logs: [] };
  const user: any = { id: 7, name: '服务者', userType: 'STAFF', status: 'ACTIVE', staffEmploymentStatus: 'ACTIVE' };
  const tx: any = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    user: { findUnique: jest.fn(async () => user) },
    walletAccount: { findUnique: jest.fn(async () => state.account) },
    walletHold: { aggregate: jest.fn(async () => ({ _sum: { amount: 1000 } })), count: jest.fn(async () => 0) },
    walletWithdrawalRequest: { findMany: jest.fn(async () => []) },
    rentalOrder: {
      create: jest.fn(async ({ data }) => {
        if (state.orders.some((o: any) => o.serialNo === data.serialNo)) throw { code: 'P2002' };
        const order = { id: state.orders.length + 1, status: 'RUNNING', version: 0, ...data }; state.orders.push(order); return order;
      }),
      findUnique: jest.fn(async ({ where }) => state.orders.find((o: any) => o.id === where.id)),
      update: jest.fn(async ({ where, data }) => {
        const order = state.orders.find((o: any) => o.id === where.id);
        Object.assign(order, { ...data, version: order.version + 1 }); return order;
      }),
    },
    walletTransaction: { create: jest.fn(async ({ data }) => {
      if (state.transactions.some((t: any) => t.sourceId === data.sourceId && t.sourceType === data.sourceType)) throw { code: 'P2002' };
      state.transactions.push(data); return data;
    }) },
    userLog: { create: jest.fn(async ({ data }) => { state.logs.push(data); return data; }) },
  };
  let tail = Promise.resolve();
  const prisma: any = { $transaction: (callback: any) => {
    const run = tail.then(async () => { const before = structuredClone(state); try { return await callback(tx); } catch (e) { state = before; throw e; } });
    tail = run.then(() => undefined, () => undefined); return run;
  } };
  const wallet: any = {
    ensureWalletAccountBucketsReady: jest.fn(),
    applyWalletAccountDelta: jest.fn(async (_tx, _id, delta) => {
      state.account.availableBalance = Math.round((state.account.availableBalance + delta.availableDelta) * 100) / 100;
      return { ...state.account };
    }),
  };
  return { service: new RentalOrdersService(prisma, wallet), tx, wallet, user, state: () => state };
}
const createInput = (v: any = {}) => ({ staffUserId: 7, prepaidAmount: 1000, depositAmount: 300, accountSourceNo: 'SOURCE-1', forcedSettlementDate: '2026-09-02', ...v });
const settleInput = (v: any = {}) => ({ version: 0, noRefundDifference: true, hasAbnormalCompensation: false, ownerSettlementAmount: 800, ...v });

describe('RentalOrdersService', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-08-31T02:00:00Z')); });
  afterEach(() => jest.useRealTimers());
  it('debits rent and deposit once, allows negative available and preserves frozen money', async () => {
    const f = fixture(); const result = await f.service.create(createInput(), 3);
    expect(result.serialNo).toMatch(/^LMSH\d{8}$/);
    expect(result.startDate.toISOString().slice(0, 10)).toBe('2026-08-31');
    expect(f.state().account).toMatchObject({ availableBalance: -800, frozenBalance: 1000 });
    expect(f.state().transactions.map((t: any) => t.bizType)).toEqual(['RENTAL_ORDER_PREPAY', 'RENTAL_ORDER_DEPOSIT']);
    expect(f.state().logs).toHaveLength(1);
  });
  it('rejects total including deposit above assets without writes', async () => {
    const f = fixture(); await expect(f.service.create(createInput({ depositAmount: 501 }), 3)).rejects.toThrow('资产不足');
    expect(f.state().transactions).toHaveLength(0); expect(f.state().orders).toHaveLength(0);
  });
  it('accepts exactly sufficient assets and cents', async () => {
    const f = fixture(); await f.service.create(createInput({ prepaidAmount: 1499.99, depositAmount: 0.01 }), 3);
    expect(f.state().account.availableBalance).toBe(-1000);
  });
  it.each(['EXITED', 'BLACKLISTED'])('blocks unavailable staff %s', async (status) => {
    const f = fixture(); f.user.staffEmploymentStatus = status;
    await expect(f.service.create(createInput(), 3)).rejects.toThrow('服务者');
  });
  it.each([
    { accountSourceNo: ' ' },
    { forcedSettlementDate: '2026-08-30' }, { prepaidAmount: -1 },
  ])('rejects invalid creation %j', async (v) => {
    const f = fixture(); await expect(f.service.create(createInput(v), 3)).rejects.toThrow(); expect(f.state().orders).toHaveLength(0);
  });
  it('concurrent requests cannot overspend assets', async () => {
    const f = fixture(); const results = await Promise.allSettled([f.service.create(createInput(), 3), f.service.create(createInput(), 3)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.state().orders).toHaveLength(1); expect(f.state().transactions).toHaveLength(2);
  });
  it('retries a generated serial collision without duplicate charge', async () => {
    const f = fixture(); const input = createInput({ prepaidAmount: 100, depositAmount: 0 });
    jest.spyOn(f.service as any, 'generateSerialNo').mockReturnValueOnce('LMSH12345678').mockReturnValueOnce('LMSH12345678').mockReturnValue('LMSH87654321');
    await f.service.create(input, 3); const second = await f.service.create(input, 3);
    expect(second.serialNo).toBe('LMSH87654321');
    expect(f.state().account.availableBalance).toBe(300);
    expect(f.state().orders).toHaveLength(2); expect(f.state().transactions).toHaveLength(2);
  });
  it('bounds collision retries and rolls back all failed attempts', async () => {
    const f = fixture(); const input = createInput({ prepaidAmount: 100, depositAmount: 0 });
    const generator = jest.spyOn(f.service as any, 'generateSerialNo').mockReturnValue('LMSH12345678');
    await f.service.create(input, 3);
    await expect(f.service.create(input, 3)).rejects.toThrow('生成繁忙');
    expect(generator).toHaveBeenCalledTimes(6);
    expect(f.state().account.availableBalance).toBe(400);
    expect(f.state().orders).toHaveLength(1); expect(f.state().transactions).toHaveLength(1);
  });
  it('ignores client supplied serial numbers', async () => {
    const f = fixture(); jest.spyOn(f.service as any, 'generateSerialNo').mockReturnValue('LMSH12345678');
    const order = await f.service.create(createInput({ serialNo: 'client-input' }), 3);
    expect(order.serialNo).toBe('LMSH12345678');
  });
  it('does not retry wallet transaction uniqueness errors', async () => {
    const f = fixture(); f.tx.walletTransaction.create.mockRejectedValue({ code: 'P2002' });
    await expect(f.service.create(createInput(), 3)).rejects.toMatchObject({ code: 'P2002' });
    expect(f.tx.rentalOrder.create).toHaveBeenCalledTimes(1);
    expect(f.state().account.availableBalance).toBe(500);
    expect(f.state().orders).toHaveLength(0);
  });
  it('rolls back order and charges if audit writing fails', async () => {
    const f = fixture(); f.tx.userLog.create.mockRejectedValue(new Error('audit failure'));
    await expect(f.service.create(createInput(), 3)).rejects.toThrow('audit failure');
    expect(f.state().orders).toHaveLength(0); expect(f.state().transactions).toHaveLength(0); expect(f.state().account.availableBalance).toBe(500);
  });
  it.each([[120, 0, 180, -620], [120, 250, -70, -870], [300, 0, 0, -800]])('settles loss %s compensation %s net %s', async (loss, compensation, net, balance) => {
    const f = fixture(); const order = await f.service.create(createInput(), 3);
    const input = settleInput({ lossAmount: loss, lossDetail: '损耗', hasAbnormalCompensation: compensation > 0,
      abnormalCompensationAmount: compensation, abnormalCompensationRemark: '规则' });
    const result = await f.service.settle(order.id, input, 3);
    expect(result.settlementNetRefund).toBe(net); expect(f.state().account.availableBalance).toBe(balance);
    await f.service.settle(order.id, input, 3);
    expect(f.state().account.availableBalance).toBe(balance); expect(f.state().transactions).toHaveLength(net === 0 ? 2 : 3);
    if (net < 0) expect(f.state().transactions[2].bizType).toBe('RENTAL_ORDER_EXCESS_CHARGE');
  });
  it('refunds full rent and deposit once at exact 2 hour boundary', async () => {
    const f = fixture(); const order = await f.service.create(createInput(), 3);
    jest.setSystemTime(new Date('2026-08-31T04:00:00Z'));
    await f.service.void(order.id, { version: 0, reason: '无法登录' }, 3);
    await f.service.void(order.id, { version: 0, reason: '重试' }, 3);
    expect(f.state().account.availableBalance).toBe(500); expect(f.state().transactions).toHaveLength(3);
    await expect(f.service.settle(order.id, settleInput(), 3)).rejects.toThrow('进行中');
  });
  it('blocks cancellation after 2 hours and stale version', async () => {
    const f = fixture(); const order = await f.service.create(createInput(), 3);
    await expect(f.service.settle(order.id, settleInput({ version: 1 }), 3)).rejects.toThrow('刷新');
    jest.setSystemTime(new Date('2026-08-31T04:00:00.001Z'));
    await expect(f.service.void(order.id, { version: 0, reason: '无法登录' }, 3)).rejects.toThrow('2小时');
    expect(f.state().transactions).toHaveLength(2);
  });
  it('concurrent settlement and void cannot both mutate money', async () => {
    const f = fixture(); const order = await f.service.create(createInput(), 3);
    const result = await Promise.allSettled([f.service.settle(order.id, settleInput(), 3), f.service.void(order.id, { version: 0, reason: '废除' }, 3)]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.state().transactions).toHaveLength(3);
  });
  it('resolves operator names in one query without returning personal fields', async () => {
    const prisma: any = {
      rentalOrder: { findUnique: jest.fn().mockResolvedValue({ id: 1, createdBy: 3, settledBy: 4, voidedBy: null }) },
      walletTransaction: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 3, name: '工作人员甲' }, { id: 4, name: '工作人员乙' }]) },
    };
    const result = await new RentalOrdersService(prisma, {} as any).detail(1);
    expect(result).toMatchObject({ createdByName: '工作人员甲', settledByName: '工作人员乙', voidedByName: null });
    expect(prisma.user.findMany).toHaveBeenCalledWith({ where: { id: { in: [3, 4] } }, select: { id: true, name: true } });
    prisma.rentalOrder.findUnique.mockResolvedValue({ id: 1, createdBy: 3, settledBy: null, voidedBy: 5 });
    expect(await new RentalOrdersService(prisma, {} as any).detail(1)).toMatchObject({ createdByName: '工作人员甲', settledByName: null, voidedByName: '未知操作人' });
  });
});
