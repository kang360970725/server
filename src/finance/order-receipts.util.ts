import { BadRequestException } from '@nestjs/common';

// 调用方须持有订单行锁；金额更新和收款快照必须在同一事务提交。
export async function recordOrderSupplementTx(tx: any, order: any, nextAmount: number, operatorId: number, now: Date) {
  const oldCents = Math.round(Number(order.paidAmount || 0) * 100);
  const nextCents = Math.round(nextAmount * 100);
  if (nextCents <= oldCents) return;
  if (!order.paymentTime) throw new BadRequestException('已收款订单缺少首次付款时间，请先核实原始收款记录');
  const dispatcher = order.dispatcherId ? await tx.user.findUnique({
    where: { id: order.dispatcherId }, select: { name: true, userType: true },
  }) : null;
  const payment = order.latestPaymentId ? await tx.orderPayment.findUnique({
    where: { id: order.latestPaymentId }, select: { channel: true },
  }) : null;
  const source = String(order.orderSource || 'CUSTOMER_SERVICE_MANUAL');
  const base = { orderId: order.id, autoSerial: order.autoSerial, orderSource: source,
    dispatcherId: order.dispatcherId || null, dispatcherName: dispatcher?.name || null,
    dispatcherType: dispatcher?.userType || null, operatorId };
  await tx.orderReceipt.upsert({
    where: { receiptKey: `INITIAL:${order.id}` }, update: {},
    create: { ...base, receiptKey: `INITIAL:${order.id}`, kind: 'INITIAL', amount: oldCents / 100,
      paidAt: order.paymentTime, channel: payment?.channel || (source === 'MINIAPP_SELF_SERVICE' ? 'MINIAPP_WECHAT' : 'MANUAL_SHOUQIANBA') },
  });
  await tx.orderReceipt.create({ data: { ...base, receiptKey: `SUPPLEMENT:${order.id}:${nextCents}`,
    kind: 'SUPPLEMENT', amount: (nextCents - oldCents) / 100, paidAt: now, channel: 'MANUAL_SHOUQIANBA' } });
}
