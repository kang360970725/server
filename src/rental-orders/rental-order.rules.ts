import { BadRequestException } from '@nestjs/common';

export function money(value: any, label: string, positive = false): number {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') {
    throw new BadRequestException(`${label}必填`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 99999999.99 || Math.abs(n * 100 - Math.round(n * 100)) > 0.00001 || (positive && n === 0)) {
    throw new BadRequestException(`${label}须为${positive ? '正数' : '非负数'}，最多两位小数且不超过99999999.99`);
  }
  return Math.round(n * 100) / 100;
}
export function textField(value: any, label: string, required = false, max = 2000): string {
  if (value != null && typeof value !== 'string') throw new BadRequestException(`${label}格式不正确`);
  const s = String(value ?? '').trim();
  if ((required && !s) || s.length > max) throw new BadRequestException(`${label}${required ? '必填，' : ''}最多${max}字`);
  return s;
}
export function dateOnly(value: any, label: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException(`${label}须为YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new BadRequestException(`${label}无效`);
  return d;
}
export function shanghaiDay(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
export function startDateFor(now = new Date()): Date {
  const local = new Date(now.getTime() + 8 * 3600000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(midnight + (local.getTime() - midnight > 14 * 3600000 ? 86400000 : 0));
}
export function todayRange(now = new Date()) {
  const start = new Date(`${shanghaiDay(now)}T00:00:00+08:00`);
  return { gte: start, lt: new Date(start.getTime() + 86400000) };
}
export function settleAmounts(order: { prepaidAmount: any; depositAmount: any }, input: any) {
  if (typeof input.noRefundDifference !== 'boolean' || typeof input.hasAbnormalCompensation !== 'boolean') {
    throw new BadRequestException('退差与异常赔付开关必填');
  }
  const refund = money(input.refundDifferenceAmount ?? 0, '退差金额');
  const loss = money(input.lossAmount ?? 0, '损耗金额');
  const compensation = money(input.abnormalCompensationAmount ?? 0, '异常赔付金额');
  const owner = money(input.ownerSettlementAmount, '号主结算金额');
  if ((input.noRefundDifference && refund !== 0) || (!input.hasAbnormalCompensation && compensation !== 0)) {
    throw new BadRequestException('关闭开关后对应金额必须为0');
  }
  if (refund > Number(order.prepaidAmount)) throw new BadRequestException('退差金额不能超过预扣租金');
  const refundDifferenceRemark = textField(input.refundDifferenceRemark, '退差说明', !input.noRefundDifference);
  const lossDetail = textField(input.lossDetail, '损耗详情', loss > 0);
  const abnormalCompensationRemark = textField(input.abnormalCompensationRemark, '异常赔付原因及规则说明', input.hasAbnormalCompensation);
  const prepaid = Math.round(Number(order.prepaidAmount) * 100);
  const deposit = Math.round(Number(order.depositAmount) * 100);
  const actualAmount = (prepaid - Math.round(refund * 100) + Math.round(loss * 100) + Math.round(compensation * 100)) / 100;
  const settlementNetRefund = (prepaid + deposit - Math.round(actualAmount * 100)) / 100;
  return {
    noRefundDifference: input.noRefundDifference, refundDifferenceAmount: refund, refundDifferenceRemark,
    lossAmount: loss, lossDetail, hasAbnormalCompensation: input.hasAbnormalCompensation,
    abnormalCompensationAmount: compensation, abnormalCompensationRemark, ownerSettlementAmount: owner,
    actualAmount, settlementNetRefund,
  };
}
