import { BadRequestException } from '@nestjs/common';

export function shanghaiReceiptDay(value: Date | string) {
  return new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function receiptRange(input: { startDate?: string; endDate?: string }) {
  const today = shanghaiReceiptDay(new Date());
  const start = input.startDate || today;
  const end = input.endDate || today;
  const parse = (s: string) => {
    const value = new Date(`${s}T00:00:00+08:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(value.getTime()) || shanghaiReceiptDay(value) !== s) {
      throw new BadRequestException('统计日期格式无效');
    }
    return value;
  };
  const startAt = parse(start), endAt = new Date(parse(end).getTime() + 86400000);
  if (startAt >= endAt) throw new BadRequestException('开始日期不能晚于结束日期');
  return { startAt, endAt, startDate: start, endDate: end };
}

export type ReceiptItem = {
  receiptId: string; kind: string; orderId?: number; autoSerial: string;
  paymentTime: Date | string; paidAmount: number; channel: string; orderSource: string;
  dispatcherId?: number | null; dispatcherName?: string | null; dispatcherUserType?: string | null;
};

export function reconcileReceipts(receipts: ReceiptItem[]) {
  const bucket = () => ({ orderIds: new Set<number>(), manualOrderIds: new Set<number>(),
    allPaid: 0, orderPaid: 0, orderCash: 0, balance: 0, manual: 0, recharge: 0, rechargeCount: 0,
    dispatcherMap: new Map<string, any>(), detailRows: [] as any[] });
  const total = bucket(), days = new Map<string, ReturnType<typeof bucket>>();
  for (const item of receipts) {
    const axis = shanghaiReceiptDay(item.paymentTime);
    if (!days.has(axis)) days.set(axis, bucket());
    const day = days.get(axis)!;
    const cents = Math.round(Number(item.paidAmount) * 100);
    const recharge = item.kind === 'RECHARGE';
    const cash = item.channel !== 'BALANCE';
    // 当前业务约定：非小程序外部收款均为收钱吧；储值消费不重复计现金。
    const manual = cash && (recharge ? item.channel === 'MANUAL' : item.orderSource !== 'MINIAPP_SELF_SERVICE');
    const detail = { ...item, paymentTime: new Date(item.paymentTime).toISOString(), paidAmount: cents / 100,
      cashAmount: cash ? cents / 100 : 0, dispatcherLabel: item.dispatcherName || '未指定',
      dispatcherUserType: item.dispatcherUserType || 'UNKNOWN',
      receiptTypeLabel: recharge ? '会员充值' : item.kind === 'SUPPLEMENT' ? '订单补收' : '订单收款',
      channelLabel: !cash ? '会员储值（不计现金）' : manual ? '收钱吧' : '小程序支付' };
    for (const b of [total, day]) {
      if (recharge) { b.recharge += cents; b.rechargeCount++; }
      else {
        b.orderIds.add(item.orderId!); b.orderPaid += cents;
        if (cash) b.orderCash += cents; else b.balance += cents;
        if (manual) b.manualOrderIds.add(item.orderId!);
      }
      if (cash) b.allPaid += cents;
      if (manual) b.manual += cents;
    }
    if (!recharge && manual) {
      const key = String(item.dispatcherId || 0);
      if (!day.dispatcherMap.has(key)) day.dispatcherMap.set(key, { dispatcherId: item.dispatcherId || null,
        dispatcherName: detail.dispatcherLabel, dispatcherLabel: detail.dispatcherLabel,
        dispatcherUserType: detail.dispatcherUserType, orderIds: new Set<number>(), cents: 0 });
      const dispatcher = day.dispatcherMap.get(key);
      dispatcher.orderIds.add(item.orderId); dispatcher.cents += cents;
    }
    day.detailRows.push(detail);
  }
  const summarize = (b: ReturnType<typeof bucket>) => ({
    allOrderCount: b.orderIds.size, allPaidAmountTotal: b.allPaid / 100,
    orderPaidAmountTotal: b.orderPaid / 100, orderCashAmountTotal: b.orderCash / 100,
    memberBalanceAmountTotal: b.balance / 100, rechargeAmountTotal: b.recharge / 100, rechargeCount: b.rechargeCount,
    manualReceiptOrderCount: b.manualOrderIds.size, manualReceiptAmountTotal: b.manual / 100,
  });
  return { summary: summarize(total), rows: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([axis, b]) => ({
    axis, ...summarize(b), dispatcherItems: [...b.dispatcherMap.values()].map(({ orderIds, cents, ...rest }) => ({
      ...rest, orderCount: orderIds.size, paidAmountTotal: cents / 100,
    })).sort((a, b) => b.paidAmountTotal - a.paidAmountTotal),
    detailRows: b.detailRows.sort((a, b) => a.paymentTime.localeCompare(b.paymentTime) || a.receiptId.localeCompare(b.receiptId)),
  })) };
}
