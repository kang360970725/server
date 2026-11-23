import { PrismaClient } from '@prisma/client';
import { round2 } from '../src/utils/money/format';

const db = new PrismaClient();
const dayMs = 86_400_000;
const day = (date: Date) => Math.floor(date.getTime() / dayMs);
const date = (value: number) => new Date(value * dayMs).toISOString().slice(0, 10);
const first = day(new Date('2026-09-01'));
const last = day(new Date('2026-12-31'));

async function main() {
  const contracts = await db.equipmentRentalContract.findMany({
    orderBy: { id: 'asc' },
    include: {
      bills: {
        where: { periodEnd: { gte: new Date('2026-09-01') }, periodStart: { lt: new Date('2027-01-01') } },
        orderBy: [{ periodStart: 'asc' }, { id: 'asc' }],
      },
    },
  });
  const reports = contracts.map((contract) => {
    const start = day(contract.startDate ?? new Date(contract.startMonth + '-01'));
    const endMonth = contract.endMonth && new Date(contract.endMonth + '-01');
    if (endMonth) endMonth.setUTCMonth(endMonth.getUTCMonth() + 1, 0);
    const end = contract.endDate ? day(contract.endDate) : endMonth ? day(endMonth) : null;
    const coverage = new Map<number, number[]>();
    const exceptions = [];
    for (const bill of contract.bills) {
      if (Number(bill.amount) <= 0) continue;
      const from = day(bill.periodStart);
      const to = day(bill.periodEnd);
      const actualFrom = Math.max(from, start);
      const actualTo = Math.min(to, end ?? to);
      for (let current = Math.max(actualFrom, first); current <= Math.min(actualTo, last); current++) {
        coverage.set(current, [...(coverage.get(current) ?? []), bill.id]);
      }
      if (actualFrom !== from || actualTo !== to) {
        const monthStart = new Date(bill.billMonth + '-01');
        monthStart.setUTCMonth(monthStart.getUTCMonth() + 1, 0);
        const legacyEnd = bill.dueAt ? day(bill.dueAt) - 1 : to;
        const daysInCycle = bill.billingSlot === -1 ? legacyEnd - from + 1 : monthStart.getUTCDate();
        const correctAmount = round2(Number(contract.monthlyAmount) * Math.max(0, actualTo - actualFrom + 1) / daysInCycle);
        exceptions.push({
          billId: bill.id, billMonth: bill.billMonth, status: bill.status, walletTxId: bill.walletTxId,
          amount: Number(bill.amount), correctAmount, difference: round2(Number(bill.amount) - correctAmount),
          currentPeriod: [date(from), date(to)],
          correctPeriod: actualFrom <= actualTo ? [date(actualFrom), date(actualTo)] : null,
          action: bill.walletTxId || (bill.status === 'PAID' && Number(bill.paidAmount) > 0)
            ? '核对实收和退费'
            : actualFrom > actualTo ? '作废' : '按实际日期重算',
        });
      }
    }
    const missing = [];
    const overlaps = [];
    for (let current = first; current <= last; current++) {
      const ids = coverage.get(current) ?? [];
      if (ids.length > 1) overlaps.push({ date: date(current), billIds: ids });
      if (current < day(new Date('2026-11-01')) && current >= start && current <= (end ?? last)
        && !(contract.status === 'INACTIVE' && end === null) && !ids.length) {
        missing.push(date(current));
      }
    }
    return {
      contractId: contract.id, userId: contract.userId, status: contract.status,
      startDate: date(start), endDate: end === null ? null : date(end),
      cutoffUnknown: contract.status === 'INACTIVE' && end === null,
      exceptions, overlaps, missing,
    };
  });
  console.log(JSON.stringify({
    contractsChecked: reports.length,
    outOfContractBills: reports.reduce((count, report) => count + report.exceptions.length, 0),
    contractsWithOverlaps: reports.filter((report) => report.overlaps.length).length,
    contractsWithMissingDays: reports.filter((report) => report.missing.length && !report.cutoffUnknown).length,
    reports,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.code ?? error.name);
  process.exitCode = 1;
}).finally(() => db.$disconnect());
