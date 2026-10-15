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
    offlineOrderIds: new Set<number>(), offline: 0, onlineOrderIds: new Set<number>(), online: 0,
    dispatcherMap: new Map<string, any>(), offlineDispatcherMap: new Map<string, any>(), detailRows: [] as any[] });
  const total = bucket(), days = new Map<string, ReturnType<typeof bucket>>();
  for (const item of receipts) {
    const axis = shanghaiReceiptDay(item.paymentTime);
    if (!days.has(axis)) days.set(axis, bucket());
    const day = days.get(axis)!;
    const cents = Math.round(Number(item.paidAmount) * 100);
    const recharge = item.kind === 'RECHARGE';
    const cash = item.channel !== 'BALANCE';
    const normalizedChannel = String(item.channel || '').trim().toUpperCase();
    const offline = !recharge && ['MANUAL', 'MANUAL_SHOUQIANBA', 'MANUAL_CONFIRMED'].includes(normalizedChannel);
    // 只有具备平台交易回执的明确渠道才能标记为“线上自动验证”；未知历史渠道不得推断为已验证。
    const online = !recharge && ['SHOUQIANBA_WAP', 'MINIAPP_WECHAT'].includes(normalizedChannel);
    // 当前业务约定：非小程序外部收款均为收钱吧；储值消费不重复计现金。
    const manual = cash && (recharge ? item.channel === 'MANUAL' : item.orderSource !== 'MINIAPP_SELF_SERVICE');
    const channelLabelMap: Record<string, string> = {
      MANUAL: '人工线下收款', MANUAL_SHOUQIANBA: '线下收款', MANUAL_CONFIRMED: '线下收款',
      SHOUQIANBA_WAP: '收钱吧在线收款', MINIAPP_WECHAT: '小程序微信支付',
      CUSTOMER_SERVICE_BALANCE: '客服责任余额代偿', BALANCE: '会员储值',
    };
    const detail = { ...item, paymentTime: new Date(item.paymentTime).toISOString(), paidAmount: cents / 100,
      cashAmount: cash ? cents / 100 : 0, dispatcherLabel: item.dispatcherName || '未指定',
      dispatcherUserType: item.dispatcherUserType || 'UNKNOWN',
      receiptTypeLabel: recharge ? '会员充值' : item.kind === 'SUPPLEMENT' ? '订单补收' : '订单收款',
      channelLabel: channelLabelMap[normalizedChannel] || (recharge ? '会员充值' : '其他收款'),
      reconciliationType: offline ? 'OFFLINE' : online ? 'ONLINE' : recharge ? 'RECHARGE' : 'OTHER',
      reconciliationLabel: offline ? '线下待人工核对' : online ? '线上自动验证' : recharge ? '会员充值' : '其他' };
    for (const b of [total, day]) {
      if (recharge) { b.recharge += cents; b.rechargeCount++; }
      else {
        b.orderIds.add(item.orderId!); b.orderPaid += cents;
        if (cash) b.orderCash += cents; else b.balance += cents;
        if (manual) b.manualOrderIds.add(item.orderId!);
        if (offline) { b.offlineOrderIds.add(item.orderId!); b.offline += cents; }
        if (online) { b.onlineOrderIds.add(item.orderId!); b.online += cents; }
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
    if (offline) {
      const key = String(item.dispatcherId || 0);
      if (!day.offlineDispatcherMap.has(key)) day.offlineDispatcherMap.set(key, { dispatcherId: item.dispatcherId || null,
        dispatcherName: detail.dispatcherLabel, dispatcherLabel: detail.dispatcherLabel,
        dispatcherUserType: detail.dispatcherUserType, orderIds: new Set<number>(), cents: 0 });
      const dispatcher = day.offlineDispatcherMap.get(key);
      dispatcher.orderIds.add(item.orderId); dispatcher.cents += cents;
    }
    day.detailRows.push(detail);
  }
  const summarize = (b: ReturnType<typeof bucket>) => ({
    allOrderCount: b.orderIds.size, allPaidAmountTotal: b.allPaid / 100,
    orderPaidAmountTotal: b.orderPaid / 100, orderCashAmountTotal: b.orderCash / 100,
    memberBalanceAmountTotal: b.balance / 100, rechargeAmountTotal: b.recharge / 100, rechargeCount: b.rechargeCount,
    manualReceiptOrderCount: b.manualOrderIds.size, manualReceiptAmountTotal: b.manual / 100,
    offlineReceiptOrderCount: b.offlineOrderIds.size, offlineReceiptAmountTotal: b.offline / 100,
    onlineReceiptOrderCount: b.onlineOrderIds.size, onlineReceiptAmountTotal: b.online / 100,
  });
  return { summary: summarize(total), rows: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([axis, b]) => ({
    axis, ...summarize(b), dispatcherItems: [...b.dispatcherMap.values()].map(({ orderIds, cents, ...rest }) => ({
      ...rest, orderCount: orderIds.size, paidAmountTotal: cents / 100,
    })).sort((a, b) => b.paidAmountTotal - a.paidAmountTotal),
    offlineDispatcherItems: [...b.offlineDispatcherMap.values()].map(({ orderIds, cents, ...rest }) => ({
      ...rest, orderCount: orderIds.size, paidAmountTotal: cents / 100,
    })).sort((a, b) => b.paidAmountTotal - a.paidAmountTotal),
    detailRows: b.detailRows.sort((a, b) => a.paymentTime.localeCompare(b.paymentTime) || a.receiptId.localeCompare(b.receiptId)),
  })) };
}
