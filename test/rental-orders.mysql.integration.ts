/**
 * Only run against a disposable local database after applying schema/migration.
 * DATABASE_URL=mysql://root@127.0.0.1:33389/bluecat_rental_test npx ts-node --transpile-only test/rental-orders.mysql.integration.ts
 * Never imports AppModule or starts schedulers. Refuses all non-test/non-local URLs.
 */
import { strict as assert } from 'assert';
import { PrismaClient } from '@prisma/client';
import { WalletService } from '../src/wallet/wallet.service';
import { WalletWithdrawalsService } from '../src/wallet/wallet-withdrawals.service';
import { RentalOrdersService } from '../src/rental-orders/rental-orders.service';
import { todayRange } from '../src/rental-orders/rental-order.rules';

const url = new URL(process.env.DATABASE_URL || '');
if (url.hostname !== '127.0.0.1' || url.port !== '33389' || url.pathname !== '/bluecat_rental_test') {
  throw new Error('Refusing non-disposable database');
}
const db = new PrismaClient();
const wallet = new WalletService(db as any);
const rental = new RentalOrdersService(db as any, wallet);
const withdrawals = new WalletWithdrawalsService(db as any, wallet, {} as any, {} as any, {} as any, {} as any, {} as any);
let seq = Number(String(Date.now()).slice(-7));
const input = (userId: number, extra: any = {}) => ({ staffUserId: userId, prepaidAmount: 1000,
  depositAmount: 300, accountSourceNo: 'TEST-SOURCE', forcedSettlementDate: '2030-01-01', ...extra });
const settlement = (extra: any = {}) => ({ version: 0, noRefundDifference: true, hasAbnormalCompensation: false, ownerSettlementAmount: 800, ...extra });
async function staff(reserved = 0) {
  const user = await db.user.create({ data: { phone: `test-${Date.now()}-${++seq}`, password: 'test-only-not-a-login', name: '测试服务者', userType: 'STAFF' } });
  await db.walletAccount.create({ data: { userId: user.id, availableBalance: 500, earningFrozenBalance: 1000,
    withdrawFrozenBalance: reserved, frozenBalance: 1000 + reserved, depositBalance: 9000 } });
  const earning = await db.walletTransaction.create({ data: { userId: user.id, direction: 'IN', bizType: 'SETTLEMENT_EARNING_BASE', amount: 1000,
    status: 'FROZEN', sourceType: 'TEST_EARNING', sourceId: user.id } });
  await db.walletHold.create({ data: { userId: user.id, earningTxId: earning.id, amount: 1000, unlockAt: new Date('2030-01-01') } });
  let request: any;
  if (reserved) {
    const reserve = await db.walletTransaction.create({ data: { userId: user.id, direction: 'OUT', bizType: 'WITHDRAW_RESERVE', amount: reserved,
      status: 'FROZEN', sourceType: 'TEST_WITHDRAW', sourceId: user.id } });
    request = await db.walletWithdrawalRequest.create({ data: { userId: user.id, amount: reserved, reserveTxId: reserve.id,
      requestNo: `TEST${user.id}`, idempotencyKey: `TEST${user.id}` } });
    await db.walletTransaction.update({ where: { id: reserve.id }, data: { sourceId: request.id } });
  }
  return { user, request };
}
async function balance(userId: number) { return Number((await db.walletAccount.findUniqueOrThrow({ where: { userId } })).availableBalance); }
async function main() {
  const operator = await db.user.create({ data: { phone: `operator-${Date.now()}`, password: 'test-only', name: '测试工作人员', userType: 'SUPER_ADMIN' } });
  const a = await staff(800);
  const first = await rental.create(input(a.user.id, { prepaidAmount: 1200, depositAmount: 0 }), operator.id);
  assert.equal(await balance(a.user.id), -700);
  const paid = await withdrawals.reviewWithdrawal({ requestId: a.request.id, reviewerId: operator.id, approve: true });
  assert.equal(paid.status, 'PAID'); assert.equal(await balance(a.user.id), -700);
  assert.equal(Number((await db.walletAccount.findUniqueOrThrow({ where: { userId: a.user.id } })).withdrawFrozenBalance), 0);
  console.log('PASS real rental debit followed by covered negative-available payout');

  const b = await staff(800);
  const second = await rental.create(input(b.user.id), operator.id);
  await rental.settle(second.id, settlement({ lossAmount: 600, lossDetail: '测试损耗' }), operator.id);
  assert.equal(await balance(b.user.id), -1100);
  await assert.rejects(withdrawals.reviewWithdrawal({ requestId: b.request.id, reviewerId: operator.id, approve: true }), /不足以覆盖/);
  assert.equal((await db.walletWithdrawalRequest.findUniqueOrThrow({ where: { id: b.request.id } })).status, 'PENDING_REVIEW');
  await withdrawals.reviewWithdrawal({ requestId: b.request.id, reviewerId: operator.id, approve: false });
  assert.equal(await balance(b.user.id), -300);
  console.log('PASS uncovered debt blocks payout; rejection returns reserved funds');

  // 强制审批先读取申请快照，再等待另一个事务占有的钱包锁。
  // 并发扣款提交后，审批必须读新余额，而非MySQL默认可重复读的旧快照。
  const waiting = await staff(800);
  let releaseWriter: () => void;
  let markLocked: () => void;
  let markRead: () => void;
  const gate = new Promise<void>(resolve => { releaseWriter = resolve; });
  const locked = new Promise<void>(resolve => { markLocked = resolve; });
  const read = new Promise<void>(resolve => { markRead = resolve; });
  const writer = db.$transaction(async tx => {
    await tx.$queryRawUnsafe('SELECT userId FROM wallet_accounts WHERE userId = ? FOR UPDATE', waiting.user.id);
    markLocked(); await gate;
    await tx.walletAccount.update({ where: { userId: waiting.user.id }, data: { availableBalance: -1200 } });
  });
  await locked;
  const tracedDb: any = { $transaction: (fn: any, options: any) => db.$transaction(tx => fn(new Proxy(tx, {
    get(target, key) {
      if (key === 'walletWithdrawalRequest') return new Proxy(target.walletWithdrawalRequest, { get(model, method) {
        if (method === 'findUnique') return async (args: any) => { const result = await model.findUnique(args); markRead(); return result; };
        return model[method];
      } });
      return target[key];
    },
  })), options) };
  const reviewer = new WalletWithdrawalsService(tracedDb, wallet, {} as any, {} as any, {} as any, {} as any, {} as any);
  const review = reviewer.reviewWithdrawal({ requestId: waiting.request.id, reviewerId: operator.id, approve: true });
  const reviewResult = assert.rejects(review, /不足以覆盖/);
  await read; releaseWriter(); await writer; await reviewResult;
  console.log('PASS payout rechecks latest committed balance after wallet-lock contention');

  const c = await staff();
  const concurrent = await Promise.allSettled([rental.create(input(c.user.id), operator.id), rental.create(input(c.user.id), operator.id)]);
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(await db.rentalOrder.count({ where: { staffUserId: c.user.id } }), 1);
  assert.equal(await balance(c.user.id), -800);
  console.log('PASS real MySQL wallet lock prevents concurrent overspending');

  const d = await staff();
  const same = input(d.user.id, { prepaidAmount: 100, depositAmount: 0 });
  const order = await rental.create(same, operator.id);
  assert.match(order.serialNo, /^LMSH\d{8}$/);
  const originalGenerator = (rental as any).generateSerialNo;
  let attempts = 0;
  (rental as any).generateSerialNo = () => ++attempts === 1 ? order.serialNo : originalGenerator.call(rental);
  let next: any;
  try { next = await rental.create(same, operator.id); }
  finally { (rental as any).generateSerialNo = originalGenerator; }
  assert.equal(attempts, 2); assert.notEqual(next.serialNo, order.serialNo);
  assert.equal(await balance(d.user.id), 300);
  await Promise.all([rental.void(order.id, { version: 0, reason: '重复请求测试' }, operator.id), rental.void(order.id, { version: 0, reason: '重复请求测试' }, operator.id)]);
  assert.equal(await balance(d.user.id), 400);
  const walletRows = await wallet.listMyTransactions(d.user.id, { orderAutoSerial: order.serialNo, includeReleaseFrozen: true } as any);
  assert.equal(walletRows.data.length, 2);
  assert.ok(walletRows.data.every(row => row.orderAutoSerial === order.serialNo));
  assert.ok(walletRows.data.some(row => row.bizType === 'RENTAL_ORDER_VOID_REFUND'));
  const detail = await rental.detail(order.id);
  assert.equal(detail.createdByName, '测试工作人员'); assert.equal(detail.voidedByName, '测试工作人员');
  console.log('PASS serial collision retry, concurrent void once, wallet references/search and operator names');

  const e = await staff(); const raceOrder = await rental.create(input(e.user.id), operator.id);
  const race = await Promise.allSettled([rental.settle(raceOrder.id, settlement({ lossAmount: 120, lossDetail: '损耗' }), operator.id), rental.void(raceOrder.id, { version: 0, reason: '测试' }, operator.id)]);
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
  const raceFinal = await db.rentalOrder.findUniqueOrThrow({ where: { id: raceOrder.id } });
  assert.equal(await balance(e.user.id), raceFinal.status === 'SETTLED' ? -620 : 500);
  console.log('PASS real settlement/void mutual exclusion');

  const f = await staff(); const centsOrder = await rental.create(input(f.user.id, { prepaidAmount: 0.29, depositAmount: 0.01 }), operator.id);
  assert.equal(await balance(f.user.id), 499.7);
  await rental.settle(centsOrder.id, settlement({ ownerSettlementAmount: 0.1 }), operator.id);
  assert.equal(await balance(f.user.id), 499.71);
  const before = await balance(f.user.id);
  const countBefore = await db.rentalOrder.count({ where: { staffUserId: f.user.id } });
  const bad = input(f.user.id, { prepaidAmount: 1, depositAmount: 0 });
  await assert.rejects(rental.create(bad, 2147483647));
  assert.equal(await balance(f.user.id), before);
  assert.equal(await db.rentalOrder.count({ where: { staffUserId: f.user.id } }), countBefore);
  console.log('PASS cent precision and audit-FK-failure rolls back order plus wallet');

  const list = await rental.list({});
  assert.equal(list.total, await db.rentalOrder.count());
  const settled = await db.rentalOrder.aggregate({ where: { status: 'SETTLED', settledAt: todayRange() },
    _count: true, _sum: { actualAmount: true, ownerSettlementAmount: true } });
  const created = await db.rentalOrder.aggregate({ where: { status: { not: 'VOIDED' }, createdAt: todayRange() },
    _count: true, _sum: { prepaidAmount: true } });
  assert.equal(Number(list.stats.settledCount), settled._count);
  assert.equal(list.stats.staffSettlementAmount, Number(settled._sum.actualAmount || 0));
  assert.equal(list.stats.ownerSettlementAmount, Number(settled._sum.ownerSettlementAmount || 0));
  assert.equal(Number(list.stats.createdCount), created._count);
  assert.equal(list.stats.rentalAmount, Number(created._sum.prepaidAmount || 0));
  const filtered = await rental.list({ search: 'no-such-test-order' });
  assert.equal(filtered.total, 0); assert.deepEqual(filtered.stats, list.stats);
  assert.ok((await rental.detail(first.id)).transactions.length > 0);
  console.log('PASS list/statistics/detail with real database');
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1; });
