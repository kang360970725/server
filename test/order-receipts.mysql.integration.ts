/** Disposable MySQL only. No AppModule, schedulers, or business database. */
import { strict as assert } from 'assert';
import { PrismaClient } from '@prisma/client';
import { OrdersService } from '../src/orders/orders.service';
import { FinanceService } from '../src/finance/finance.service';
import { shanghaiReceiptDay } from '../src/finance/receipt-reconciliation';

if (process.env.DATABASE_URL !== 'mysql://root@127.0.0.1:33389/bluecat_rental_test') throw new Error('Refusing non-disposable database');
const db = new PrismaClient();
const orders: any = new OrdersService(db as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
const finance = new FinanceService(db as any);
async function main() {
  const suffix = Date.now();
  const user = await db.user.create({ data: { phone: `receipt-test-${suffix}`, password: 'test-only', name: '收款测试', userType: 'SUPER_ADMIN' } });
  const project = await db.gameProject.create({ data: { name: '收款测试', price: 100, type: 'EXPERIENCE', billingMode: 'HOURLY' } });
  const yesterday = new Date(Date.now() - 86400000);
  const order = await db.order.create({ data: { autoSerial: `RECEIPT-${suffix}`, receivableAmount: 100, paidAmount: 100,
    projectId: project.id, projectSnapshot: { billingMode: 'HOURLY' }, isPaid: true, paymentTime: yesterday,
    orderSource: 'CUSTOMER_SERVICE_MANUAL', dispatcherId: user.id } });
  await Promise.all([orders.updatePaidAmount(order.id, 150, user.id), orders.updatePaidAmount(order.id, 150, user.id)]);
  let receipts = await db.orderReceipt.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' } });
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.map(r => [r.kind, Number(r.amount)]), [['INITIAL', 100], ['SUPPLEMENT', 50]]);
  assert.equal(receipts[0].paidAt.getTime(), yesterday.getTime());
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentTime?.getTime(), yesterday.getTime());
  console.log('PASS concurrent supplement produces exactly one initial snapshot and one incremental receipt');
  const prev = shanghaiReceiptDay(yesterday), today = shanghaiReceiptDay(new Date());
  const oldDay = await finance.dashboardReconciliation({ startDate: prev, endDate: prev });
  const todayDay = await finance.dashboardReconciliation({ startDate: today, endDate: today });
  const amountFor = (r: any) => r.data.rows.flatMap((d: any) => d.detailRows).filter((d: any) => d.orderId === order.id).reduce((s: number, d: any) => s + d.cashAmount, 0);
  assert.equal(amountFor(oldDay), 100); assert.equal(amountFor(todayDay), 50);
  console.log('PASS actual database daily report: yesterday 100, today 50; no backfill or double counting');
  const originalLog = orders.writeUserLog;
  orders.writeUserLog = async () => { throw new Error('TEST_ROLLBACK'); };
  try { await assert.rejects(orders.updatePaidAmount(order.id, 180, user.id), /TEST_ROLLBACK/); }
  finally { orders.writeUserLog = originalLog; }
  assert.equal(await db.orderReceipt.count({ where: { orderId: order.id } }), 2);
  assert.equal((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paidAmount, 150);
  console.log('PASS failed transaction rolls back both aggregate paid amount and receipt');
  await assert.rejects(orders.updateOrderEditable({ id: order.id, paidAmount: 200 }, user.id), /不能直接修改/);
  await assert.rejects(orders.updateOrderEditable({ id: order.id, paymentTime: new Date().toISOString() }, user.id), /不能直接修改/);
  console.log('PASS ordinary edit cannot alter paid amount or move historical receipts');
  const recharge = await db.memberRechargeOrder.create({ data: { rechargeNo: `RECHARGE-${suffix}`, userId: user.id,
    amount: 200, payAmount: 200, bonusAmount: 50, grantedAmount: 250, channel: 'MANUAL', status: 'SUCCESS', paidAt: new Date() } });
  await db.memberRechargeOrder.create({ data: { rechargeNo: `PENDING-${suffix}`, userId: user.id,
    amount: 999, payAmount: 999, channel: 'MANUAL', status: 'PENDING', paidAt: new Date() } });
  const updated = await finance.dashboardReconciliation({ startDate: today, endDate: today });
  const details = updated.data.rows.flatMap(d => d.detailRows);
  assert.equal(details.find(d => d.receiptId === `RECHARGE:${recharge.id}`).cashAmount, 200);
  assert.ok(!details.some(d => d.autoSerial === `PENDING-${suffix}`));
  assert.equal(updated.data.summary.allPaidAmountTotal - todayDay.data.summary.allPaidAmountTotal, 200);
  console.log('PASS successful recharge adds principal only; pending recharge and bonus excluded');
}
main().finally(() => db.$disconnect()).catch(e => { console.error(e); process.exitCode = 1; });
