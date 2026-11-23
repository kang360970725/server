import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, PrismaClient, StaffEmploymentStatus, UserType } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { round2 } from '../utils/money/format';

type PrismaTx = PrismaClient | Prisma.TransactionClient;

const BILLABLE_STAFF_STATUSES = [StaffEmploymentStatus.ACTIVE, StaffEmploymentStatus.FROZEN] as const;
const CALENDAR_BILLING_TRANSITION_MONTH = '2026-10';
const LAST_LEGACY_SERVICE_MONTH = '2026-09'; // The former job billed by due month.
const BILLABLE_STAFF_STATUS_SET = new Set<StaffEmploymentStatus>([...BILLABLE_STAFF_STATUSES]);

@Injectable()
export class EquipmentRentalFeeService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeMonth(month: any) {
    const value = String(month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(value)) {
      throw new BadRequestException('月份格式必须为 YYYY-MM');
    }
    const [, m] = value.split('-').map(Number);
    if (m < 1 || m > 12) throw new BadRequestException('月份格式必须为 YYYY-MM');
    return value;
  }

  private getMonthRange(month: string) {
    const [year, mon] = this.normalizeMonth(month).split('-').map(Number);
    return {
      start: new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0)),
      end: new Date(Date.UTC(year, mon, 0, 23, 59, 59)),
    };
  }

  private formatMonth(date: Date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private toDateOnlyString(date: Date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  private normalizeDate(value: any, fieldName: string) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
    }
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) throw new BadRequestException(`${fieldName}格式必须为 YYYY-MM-DD`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      Number.isNaN(date.getTime()) ||
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      throw new BadRequestException(`${fieldName}格式必须为 YYYY-MM-DD`);
    }
    return date;
  }

  private getContractStartDate(contract: any) {
    if (contract?.startDate) return this.normalizeDate(contract.startDate, '起租日');
    return this.normalizeDate(`${this.normalizeMonth(contract?.startMonth)}-01`, '起租日');
  }

  private getContractEndDate(contract: any) {
    if (contract?.endDate) return this.normalizeDate(contract.endDate, '结束日');
    if (contract?.endMonth) {
      const [year, mon] = this.normalizeMonth(contract.endMonth).split('-').map(Number);
      return new Date(Date.UTC(year, mon, 0));
    }
    return null;
  }

  private getBillingSchedule(contract: any, billMonth: string, cutoffDateInput?: Date) {
    const startDate = this.getContractStartDate(contract);
    const endDate = this.getContractEndDate(contract);
    const { start: monthStart, end: monthEnd } = this.getMonthRange(billMonth);
    const cutoffDate = cutoffDateInput
      ? this.normalizeDate(cutoffDateInput, '结算截止日')
      : null;
    const periodStart = startDate > monthStart ? startDate : monthStart;
    let periodEnd = endDate && endDate < monthEnd ? endDate : monthEnd;
    if (cutoffDate && cutoffDate < periodEnd) periodEnd = cutoffDate;
    if (periodEnd < periodStart) return null;
    const daysInMonth = monthEnd.getUTCDate();
    const billableDays = Math.floor((periodEnd.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    const amount = round2(Number(contract.monthlyAmount || 0) * billableDays / daysInMonth);
    const [year, mon] = this.normalizeMonth(billMonth).split('-').map(Number);
    const dueAt = cutoffDate || new Date(Date.UTC(year, mon, 1));
    return { startDate, dueAt, periodStart, periodEnd, daysInMonth, billableDays, amount };
  }

  private async getBillingSegments(
    db: PrismaTx,
    contract: any,
    month: string,
    cutoffDate?: Date,
  ) {
    const terms = this.getBillingSchedule(contract, month, cutoffDate);
    if (!terms) return [];
    const { start, end } = this.getMonthRange(month);
    const legacyBills = await db.equipmentRentalBill.findMany({
      where: {
        contractId: contract.id,
        billingSlot: -1,
        periodStart: { lte: end },
        periodEnd: { gte: start },
      },
      select: { periodStart: true, periodEnd: true },
      orderBy: { periodStart: 'asc' },
    });
    const day = 86400000;
    const segments: (typeof terms)[] = [];
    let cursor = terms.periodStart.getTime();
    const endDay = this.normalizeDate(terms.periodEnd, '计费结束日').getTime();
    for (const bill of legacyBills) {
      const coveredStart = this.normalizeDate(bill.periodStart, '计费开始日').getTime();
      if (coveredStart > endDay) break;
      if (coveredStart > cursor) {
        segments.push({ ...terms, periodStart: new Date(cursor), periodEnd: new Date(coveredStart - 1000) });
      }
      cursor = Math.max(cursor, this.normalizeDate(bill.periodEnd, '计费结束日').getTime() + day);
    }
    if (cursor <= endDay) segments.push({ ...terms, periodStart: new Date(cursor) });
    return segments.map((segment, billingSlot) => {
      const billableDays = Math.floor((segment.periodEnd.getTime() - segment.periodStart.getTime()) / day) + 1;
      return {
        ...segment,
        billingSlot,
        amount: round2(Number(contract.monthlyAmount) * billableDays / terms.daysInMonth),
      };
    });
  }

  private recalculateLegacyBill(contract: any, bill: { periodStart: Date; periodEnd: Date; dueAt: Date | null }) {
    const startDate = this.getContractStartDate(contract);
    const endDate = this.getContractEndDate(contract);
    const periodStart = startDate > bill.periodStart ? startDate : bill.periodStart;
    const periodEnd = endDate && endDate < bill.periodEnd ? endDate : bill.periodEnd;
    const day = 86400000;
    const billableDays = Math.max(0, Math.floor((periodEnd.getTime() - periodStart.getTime()) / day) + 1);
    const originalEnd = bill.dueAt ? bill.dueAt.getTime() - 1 : bill.periodEnd.getTime();
    const daysInPeriod = Math.floor((originalEnd - bill.periodStart.getTime()) / day) + 1;
    return {
      periodStart: bill.periodStart,
      periodEnd: periodEnd >= bill.periodStart ? periodEnd : bill.periodEnd,
      dueAt: bill.dueAt,
      amount: round2(Number(contract.monthlyAmount) * billableDays / daysInPeriod),
    };
  }

  private getCurrentMonth(ref = new Date()) {
    return `${ref.getUTCFullYear()}-${String(ref.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private getNextMonth(ref = new Date()) {
    const next = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private toAmount(value: any) {
    const amount = round2(Number(value || 0));
    if (!Number.isFinite(amount) || amount < 0) throw new BadRequestException('金额必须大于等于 0');
    return amount;
  }

  private async writeLogTx(db: PrismaTx, params: {
    operatorId?: number;
    action: string;
    targetType?: string;
    targetId?: number | null;
    oldData?: any;
    newData?: any;
    remark?: string | null;
  }) {
    if (!params.operatorId) return;
    await (db as any).userLog.create({
      data: {
        userId: params.operatorId,
        action: params.action,
        targetType: params.targetType || 'EQUIPMENT_RENTAL_BILL',
        targetId: params.targetId ?? null,
        oldData: params.oldData ?? undefined,
        newData: params.newData ?? undefined,
        remark: params.remark ?? null,
      },
    });
  }

  private isContractEffectiveForMonth(contract: any, month: string) {
    if (String(contract?.status || '') !== 'ACTIVE') return false;
    return Boolean(this.getBillingSchedule(contract, month));
  }

  async createContract(dto: any, operatorId?: number) {
    const userId = Number(dto?.userId);
    const monthlyAmount = this.toAmount(dto?.monthlyAmount);
    const startDate = dto?.startDate
      ? this.normalizeDate(dto.startDate, '起租日')
      : this.normalizeDate(`${this.normalizeMonth(dto?.startMonth)}-01`, '起租日');
    const endDate = dto?.endDate
      ? this.normalizeDate(dto.endDate, '结束日')
      : dto?.endMonth
        ? this.getContractEndDate({ endMonth: dto.endMonth })
        : null;
    const startMonth = this.formatMonth(startDate);
    const endMonth = endDate ? this.formatMonth(endDate) : null;
    if (!userId) throw new BadRequestException('请选择员工');
    if (monthlyAmount <= 0) throw new BadRequestException('月租金额必须大于 0');
    if (endDate && endDate.getTime() < startDate.getTime()) throw new BadRequestException('结束日不能早于起租日');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { userType: true, workMode: true, staffEmploymentStatus: true },
    });
    if (!user) throw new NotFoundException('员工不存在');
    if (user.userType !== UserType.STAFF || !BILLABLE_STAFF_STATUS_SET.has(user.staffEmploymentStatus)) {
      throw new BadRequestException('仅支持为未退店、未拉黑陪玩配置设备租赁费');
    }

    return this.prisma.$transaction(async (tx) => {
      const contract = await (tx as any).equipmentRentalContract.create({
        data: {
          userId,
          monthlyAmount,
          startMonth,
          endMonth,
          startDate,
          endDate,
          remark: String(dto?.remark || '').trim() || null,
          createdBy: operatorId || null,
        },
        include: { user: { select: { id: true, name: true, phone: true, workMode: true } } },
      });
      await this.writeLogTx(tx as any, {
        operatorId,
        action: 'EQUIPMENT_RENTAL_CONTRACT_CREATE',
        targetType: 'EQUIPMENT_RENTAL_CONTRACT',
        targetId: contract.id,
        newData: contract,
        remark: '新增设备租赁配置',
      });
      return contract;
    });
  }

  async updateContract(dto: any, operatorId?: number) {
    const id = Number(dto?.id);
    if (!id) throw new BadRequestException('id 必填');
    const existing = await (this.prisma as any).equipmentRentalContract.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('租赁配置不存在');

    const data: any = {};
    if (dto?.monthlyAmount !== undefined) data.monthlyAmount = this.toAmount(dto.monthlyAmount);
    if (dto?.startDate !== undefined || dto?.startMonth !== undefined) {
      const startDate = dto?.startDate
        ? this.normalizeDate(dto.startDate, '起租日')
        : this.normalizeDate(`${this.normalizeMonth(dto.startMonth)}-01`, '起租日');
      data.startDate = startDate;
      data.startMonth = this.formatMonth(startDate);
    }
    if (dto?.endDate !== undefined || dto?.endMonth !== undefined) {
      const endDate = dto?.endDate
        ? this.normalizeDate(dto.endDate, '结束日')
        : dto?.endMonth
          ? this.getContractEndDate({ endMonth: dto.endMonth })
          : null;
      data.endDate = endDate;
      data.endMonth = endDate ? this.formatMonth(endDate) : null;
    }
    if (dto?.status !== undefined) data.status = String(dto.status) === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
    if (dto?.remark !== undefined) data.remark = String(dto.remark || '').trim() || null;
    const nextStart = data.startDate ?? this.getContractStartDate(existing);
    const nextEnd = data.endDate !== undefined ? data.endDate : this.getContractEndDate(existing);
    if (nextEnd && nextEnd.getTime() < nextStart.getTime()) throw new BadRequestException('结束日不能早于起租日');

    const today = this.normalizeDate(new Date(Date.now() + 8 * 60 * 60 * 1000), '当前日期');
    const cutoffChanged = (data.endDate !== undefined && +nextEnd !== +this.getContractEndDate(existing))
      || (data.status === 'INACTIVE' && existing.status !== 'INACTIVE');
    if (data.status === 'INACTIVE' && cutoffChanged && !nextEnd) {
      throw new BadRequestException('停用租赁合同前，请填写实际截止日');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await (tx as any).equipmentRentalContract.update({
        where: { id, updatedAt: existing.updatedAt },
        data,
        include: { user: { select: { id: true, name: true, phone: true, workMode: true } } },
      });
      await this.writeLogTx(tx as any, {
        operatorId,
        action: 'EQUIPMENT_RENTAL_CONTRACT_UPDATE',
        targetType: 'EQUIPMENT_RENTAL_CONTRACT',
        targetId: id,
        oldData: existing,
        newData: updated,
        remark: '编辑设备租赁配置',
      });
      const reconciliations = [];
      if (cutoffChanged && nextEnd) {
        const cutoffMonth = this.formatMonth(nextEnd);
        const earlyBills = await tx.equipmentRentalBill.findMany({
          where: { contractId: id, billMonth: { gte: cutoffMonth } },
          select: { billMonth: true },
        });
        const months = new Set(earlyBills.map((bill) => bill.billMonth));
        if (nextEnd <= today) months.add(cutoffMonth);
        for (const month of months) {
          const result = await this.reconcileContractMonth(tx, updated, month, operatorId, {
            targeted: true, cutoffDate: month === cutoffMonth && nextEnd <= today ? nextEnd : undefined,
          });
          reconciliations.push(...result.reconciliations);
        }
      }
      return { ...updated, reconciliations };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async listContracts(query: any) {
    const page = Math.max(1, Number(query?.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query?.limit ?? 20)));
    const where: any = {};
    if (query?.status) where.status = String(query.status);
    if (query?.userId) where.userId = Number(query.userId);
    const [list, total] = await this.prisma.$transaction([
      (this.prisma as any).equipmentRentalContract.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ id: 'desc' }],
        include: { user: { select: { id: true, name: true, phone: true, workMode: true, staffEmploymentStatus: true } } },
      }),
      (this.prisma as any).equipmentRentalContract.count({ where }),
    ]);
    return { list, total, page, limit };
  }

  async generateBillsForMonth(monthInput: string, operatorId?: number, manual = Boolean(operatorId), contractId?: number) {
    const month = this.normalizeMonth(monthInput);
    const shanghaiNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const today = this.normalizeDate(shanghaiNow, '当前日期');
    const dueDay = new Date(this.getMonthRange(month).end.getTime() + 1000);
    if (manual && dueDay.getTime() - today.getTime() > 7 * 86_400_000) {
      throw new BadRequestException('设备租赁账单最多可在缴费日前 7 天生成');
    }
    const months = !contractId && month >= CALENDAR_BILLING_TRANSITION_MONTH
      ? [...new Set([LAST_LEGACY_SERVICE_MONTH, CALENDAR_BILLING_TRANSITION_MONTH, month])]
      : [month];
    if (contractId !== undefined && (!Number.isSafeInteger(contractId) || contractId <= 0)) {
      throw new BadRequestException('合同 ID 无效');
    }
    const contracts = await (this.prisma as any).equipmentRentalContract.findMany({
      where: contractId ? { id: contractId } : {
        user: { userType: UserType.STAFF },
        OR: [
          { status: 'ACTIVE', user: { staffEmploymentStatus: { in: [...BILLABLE_STAFF_STATUSES] } } },
          { status: 'INACTIVE', endDate: { gte: this.getMonthRange(month).start } },
          { status: 'INACTIVE', bills: { some: { billingSlot: -1, billMonth: { in: [LAST_LEGACY_SERVICE_MONTH, CALENDAR_BILLING_TRANSITION_MONTH] } } } },
          { bills: { some: { billMonth: month, ...(operatorId ? {} : { billingSlot: { gte: 0 } }) } } },
        ],
      },
    });

    if (contractId && !contracts.length) throw new NotFoundException('设备租赁合同不存在');
    if (contractId && contracts[0].status === 'INACTIVE' && !this.getContractEndDate(contracts[0])) {
      throw new BadRequestException('请先确认停用合同的实际截止日');
    }

    let affected = 0;
    let correct = 0;
    const reconciliations: any[] = [];
    for (const contract of contracts) {
      for (const billingMonth of months) {
        await this.prisma.$transaction(async (db) => {
          const currentContract = await db.equipmentRentalContract.findUnique({ where: { id: contract.id } });
          if (!currentContract) return;
          const result = await this.reconcileContractMonth(db, currentContract, billingMonth, operatorId, {
            backfillOnly: billingMonth !== month, targeted: Boolean(contractId),
          });
          affected += result.affected;
          correct += result.correct;
          reconciliations.push(...result.reconciliations);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      }
    }
    return { month, affected, correct, reconciliations };
  }

  private async reconcileContractMonth(
    db: PrismaTx,
    currentContract: Prisma.EquipmentRentalContractGetPayload<{}>,
    billingMonth: string,
    operatorId: number | undefined,
    { backfillOnly = false, targeted = false, cutoffDate }: {
      backfillOnly?: boolean; targeted?: boolean; cutoffDate?: Date;
    } = {},
  ) {
    let affected = 0;
    let correct = 0;
    const reconciliations: any[] = [];
    const segments = await this.getBillingSegments(db, currentContract, billingMonth, cutoffDate);
    const existingBills = await db.equipmentRentalBill.findMany({
      where: {
        contractId: currentContract.id,
        billMonth: billingMonth,
        ...((operatorId || targeted) && !backfillOnly ? {} : { billingSlot: { gte: 0 } }),
      },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        walletTx: {
          select: {
            id: true,
            amount: true,
            sourceType: true,
            reversals: { select: { amount: true, direction: true, status: true } },
          },
        },
      },
    });
    const billsBySlot = new Map(existingBills.map((bill) => [bill.billingSlot, bill]));
    const slots = new Set([...segments.map((segment) => segment.billingSlot), ...billsBySlot.keys()]);
    for (const billingSlot of slots) {
      const existing = billsBySlot.get(billingSlot);
      const terms = billingSlot === -1
        ? this.recalculateLegacyBill(currentContract, existing)
        : segments[billingSlot];
      if (backfillOnly && existing) continue;
      if (!targeted && !existing && currentContract.status === 'INACTIVE'
        && !this.getContractEndDate(currentContract)) continue;
      const { periodStart, periodEnd, dueAt, amount } = terms ?? {
        periodStart: existing.periodStart, periodEnd: existing.periodEnd, dueAt: existing.dueAt, amount: 0,
      };
      const overwrite = existing && !existing.walletTxId
        && (existing.status === 'PENDING' || amount < Number(existing.amount)
          || (existing.status === 'PAID' && Number(existing.amount) === 0 && !existing.confirmedAt));
      if (existing && (!overwrite || (targeted && existing.status !== 'PENDING' && Number(existing.paidAmount) > 0 && existing.status !== 'WAIVED'))) {
        const currentAmount = this.toAmount(existing.amount);
        const difference = round2(currentAmount - amount);
        const refundedAmount = round2(
          (existing.walletTx?.reversals || [])
            .filter((item: any) => item.direction === 'IN' && item.status !== 'REVERSED')
            .reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0),
        );
        if (Math.abs(difference) < 0.005 && (!terms || (
          +existing.periodStart === +periodStart && +existing.periodEnd === +periodEnd
        ))) {
          correct += 1;
        } else {
          const adminPayLog = existing.walletTxId
            ? await db.userLog.findFirst({
                where: {
                  targetType: 'EQUIPMENT_RENTAL_BILL',
                  targetId: existing.id,
                  action: 'EQUIPMENT_RENTAL_BILL_ADMIN_PAY',
                },
                select: { id: true },
              })
            : null;
          const isSelfConfirmedPayment = Boolean(existing.walletTxId)
            && existing.walletTx?.sourceType !== 'EQUIPMENT_RENTAL_BILL_ADMIN_PAY'
            && !adminPayLog;
          reconciliations.push({
            billId: existing.id,
            billMonth: billingMonth,
            userId: currentContract.userId,
            user: existing.user,
            currentAmount,
            correctAmount: amount,
            difference,
            refundedAmount,
            refundableAmount: round2(Math.max(0, Number(existing.paidAmount || 0))),
            canRefund: difference > 0 && isSelfConfirmedPayment && Number(existing.paidAmount || 0) > 0,
            reason: difference > 0
              ? (isSelfConfirmedPayment ? '重算金额低于已扣金额，可确认退还差额' : '仅服务者自行确认扣缴且存在钱包流水的账单可退费')
              : difference < 0 ? '重算金额高于当前账单，请人工核对后处理' : '计费区间有差异，请人工核对',
          });
        }
        continue;
      }
      if (existing) {
        const settled = existing.status !== 'PENDING' && (Number(existing.amount) > 0 || Boolean(existing.confirmedAt));
        const paidAmount = settled ? amount : Math.min(amount, Number(existing.paidAmount));
        const remainingAmount = round2(amount - paidAmount);
        const updated = await db.equipmentRentalBill.update({
          where: { id: existing.id, updatedAt: existing.updatedAt, AND: { walletTxId: null } },
          data: {
            contractId: currentContract.id,
            periodStart,
            periodEnd,
            amount,
            paidAmount,
            remainingAmount,
            status: remainingAmount > 0 ? 'PENDING' : existing.status === 'WAIVED' ? 'WAIVED' : 'PAID',
            dueAt,
            remark: amount > 0 && /^已作废[：:]/.test(existing.remark || '') ? null
              : !terms && amount === 0 ? '已作废：计费区间超出合同有效期' : existing.remark,
            generatedAt: new Date(),
          },
        });
        await this.writeLogTx(db, {
          operatorId,
          action: 'EQUIPMENT_RENTAL_BILL_GENERATE_UPDATE',
          targetId: existing.id,
          oldData: existing,
          newData: updated,
          remark: `生成/更新设备租赁账单 ${billingMonth}`,
        });
      } else {
        const created = await db.equipmentRentalBill.create({
          data: {
            contractId: currentContract.id,
            userId: currentContract.userId,
            billMonth: billingMonth,
            billingSlot,
            periodStart,
            periodEnd,
            amount,
            paidAmount: 0,
            remainingAmount: amount,
            status: amount > 0 ? 'PENDING' : 'PAID',
            dueAt,
            generatedAt: new Date(),
          },
        });
        await this.writeLogTx(db, {
          operatorId,
          action: 'EQUIPMENT_RENTAL_BILL_GENERATE_CREATE',
          targetId: created.id,
          newData: created,
          remark: `生成设备租赁账单 ${billingMonth}`,
        });
      }
      affected += 1;
    }
    return { affected, correct, reconciliations };
  }

  @Cron('0 10 1 * * *', { timeZone: 'Asia/Shanghai' })
  async cronGenerateCurrentMonthBills() {
    const now = new Date();
    const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const previousMonth = new Date(Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth() - 1, 1));
    await this.generateBillsForMonth(this.formatMonth(previousMonth));
  }

  async listBills(query: any) {
    const page = Math.max(1, Number(query?.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query?.limit ?? 20)));
    const where: any = {};
    if (query?.billMonth) where.billMonth = this.normalizeMonth(query.billMonth);
    if (query?.status) where.status = String(query.status);
    if (query?.userId) where.userId = Number(query.userId);
    if (query?.contractId) where.contractId = Number(query.contractId);
    if (query?.onlyRisk) where.status = 'PENDING';

    const { rows, total, stats, logs } = await this.prisma.$transaction(async (tx) => {
      const scopedRows = await (tx as any).equipmentRentalBill.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ billMonth: 'desc' }, { id: 'desc' }],
        include: {
          walletTx: {
            select: {
              id: true,
              amount: true,
              direction: true,
              bizType: true,
              sourceType: true,
              reversals: {
                where: { direction: 'IN' },
                select: { id: true, amount: true, status: true, createdAt: true, remark: true },
              },
            },
          },
          user: {
            select: {
              id: true,
              name: true,
              phone: true,
              workMode: true,
              walletAccount: { select: { availableBalance: true, frozenBalance: true } },
            },
          },
        },
      });
      const scopedTotal = await (tx as any).equipmentRentalBill.count({ where });
      const scopedStats = await this.getBillStatsTx(tx as any, where);
      const billIds = scopedRows.map((row: any) => Number(row.id));
      const logs = billIds.length
        ? await (tx as any).userLog.findMany({
            where: {
              targetType: 'EQUIPMENT_RENTAL_BILL',
              targetId: { in: billIds },
            },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              userId: true,
              action: true,
              targetId: true,
              remark: true,
              oldData: true,
              newData: true,
              createdAt: true,
              user: { select: { id: true, name: true, phone: true } },
            },
          })
        : [];
      return { rows: scopedRows, total: scopedTotal, stats: scopedStats, logs };
    });

    const list = rows.map((row: any) => {
      const available = Number(row?.user?.walletAccount?.availableBalance || 0);
      const frozen = Number(row?.user?.walletAccount?.frozenBalance || 0);
      const totalAssets = round2(available + frozen);
      const remaining = Number(row?.remainingAmount || 0);
      const refundedAmount = round2(
        (row?.walletTx?.reversals || [])
          .filter((item: any) => item.status !== 'REVERSED')
          .reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0),
      );
      const rowLogs = logs.filter((item: any) => Number(item.targetId) === Number(row.id));
      const hasAdminPayLog = rowLogs.some((item: any) => item.action === 'EQUIPMENT_RENTAL_BILL_ADMIN_PAY');
      const isSelfConfirmedPayment = Boolean(row.walletTxId)
        && row.walletTx?.sourceType !== 'EQUIPMENT_RENTAL_BILL_ADMIN_PAY'
        && !hasAdminPayLog;
      return {
        ...row,
        refundedAmount,
        refundableAmount: isSelfConfirmedPayment ? round2(Math.max(0, Number(row.paidAmount || 0))) : 0,
        canRefund: isSelfConfirmedPayment && Number(row.paidAmount || 0) > 0,
        adjustmentLogs: rowLogs,
        totalAssets,
        insufficient: row.status === 'PENDING' && totalAssets < remaining,
      };
    });
    return { list, total, page, limit, stats };
  }

  private async getBillStatsTx(db: PrismaTx, where: any) {
    const rows = await (db as any).equipmentRentalBill.findMany({
      where,
      select: { amount: true, remainingAmount: true, status: true, walletTxId: true, remark: true },
    });
    return rows.reduce((acc: any, row: any) => {
      const amount = Number(row.amount || 0);
      const remaining = Number(row.remainingAmount || 0);
      const settled = round2(Math.max(0, amount - remaining));
      acc.billAmount = round2(acc.billAmount + amount);
      acc.remainingAmount = round2(acc.remainingAmount + remaining);
      if (String(row.status || '') === 'WAIVED') acc.waivedAmount = round2(acc.waivedAmount + settled);
      else if (row.walletTxId) acc.chargedAmount = round2(acc.chargedAmount + settled);
      else if (settled > 0) acc.externalPaidAmount = round2(acc.externalPaidAmount + settled);
      return acc;
    }, { billAmount: 0, remainingAmount: 0, chargedAmount: 0, externalPaidAmount: 0, waivedAmount: 0 });
  }

  async listMyBills(userId: number) {
    return (this.prisma as any).equipmentRentalBill.findMany({
      where: { userId, status: 'PENDING' },
      orderBy: [{ billMonth: 'asc' }, { id: 'asc' }],
    });
  }

  private async assertBillReadyForPayment(tx: Prisma.TransactionClient, bill: Prisma.EquipmentRentalBillGetPayload<{}>, cutoffDate?: Date) {
    const contract = await tx.equipmentRentalContract.findUnique({ where: { id: bill.contractId } });
    if (!contract || (contract.status === 'INACTIVE' && !this.getContractEndDate(contract))) {
      throw new BadRequestException('设备租赁合同截止日待核对');
    }
    const today = this.normalizeDate(new Date(Date.now() + 8 * 60 * 60 * 1000), '当前日期');
    if (!cutoffDate && this.normalizeDate(bill.periodEnd, '计费结束日') >= today
      && (!this.getContractEndDate(contract) || +this.getContractEndDate(contract) > +today)) {
      throw new BadRequestException('计费周期尚未结束，请到期后缴费');
    }
    const { start, end } = this.getMonthRange(bill.billMonth);
    const bills = await tx.equipmentRentalBill.findMany({
      where: { contractId: bill.contractId, periodStart: { lte: end }, periodEnd: { gte: start }, amount: { gt: 0 } },
    });
    const terms = await this.getBillingSegments(tx, contract, bill.billMonth, cutoffDate);
    const matches = (row: typeof bill, term: { periodStart: Date; periodEnd: Date; amount: number }) =>
      this.toDateOnlyString(row.periodStart) === this.toDateOnlyString(term.periodStart)
      && this.toDateOnlyString(row.periodEnd) === this.toDateOnlyString(term.periodEnd)
      && this.toAmount(row.amount) === term.amount;
    const calendarBills = bills.filter((row) => row.billingSlot >= 0);
    const legacyBills = bills.filter((row) => row.billingSlot === -1);
    const legacyOverlap = legacyBills.some((row, index) => legacyBills.slice(index + 1)
      .some((other) => row.periodStart <= other.periodEnd && row.periodEnd >= other.periodStart));
    if (legacyOverlap || legacyBills.some((row) => !matches(row, this.recalculateLegacyBill(contract, row)))
      || calendarBills.length !== terms.filter((term) => term.amount > 0).length
      || terms.some((term) => term.amount > 0 && calendarBills.filter((row) => matches(row, term)).length !== 1)
      || !this.toAmount(bill.remainingAmount)
      || (bill.billingSlot === -1 && !matches(bill, this.recalculateLegacyBill(contract, bill)))) {
      throw new BadRequestException('设备租赁账期或金额有差异，请先核准修复再缴费');
    }
  }

  private async payBillInTx(tx: any, bill: any, operatorId?: number, remark?: string) {
    const userId = Number(bill.userId);
    const amount = this.toAmount(bill.remainingAmount);
    const account = await (tx as any).walletAccount.findUnique({
      where: { userId },
      select: { availableBalance: true, frozenBalance: true },
    });
    const available = Number(account?.availableBalance || 0);
    const frozen = Number(account?.frozenBalance || 0);
    const totalAfter = round2(available + frozen - amount);
    if (totalAfter < 0) {
      throw new BadRequestException('账户总资产不足，无法确认扣除设备租赁费');
    }

    const after = await (tx as any).walletAccount.update({
      where: { userId },
      data: { availableBalance: { decrement: amount } },
      select: { availableBalance: true, frozenBalance: true },
    });
    const walletTx = await (tx as any).walletTransaction.create({
      data: {
        userId,
        direction: 'OUT',
        bizType: 'EQUIPMENT_RENTAL_FEE',
        amount,
        status: 'AVAILABLE',
        sourceType: operatorId ? 'EQUIPMENT_RENTAL_BILL_ADMIN_PAY' : 'EQUIPMENT_RENTAL_BILL_SELF_CONFIRM',
        sourceId: bill.id,
        availableAfter: round2(Number(after.availableBalance || 0)),
        frozenAfter: round2(Number(after.frozenBalance || 0)),
        remark: String(remark || '').trim() || `设备租赁费 ${bill.billMonth}`,
      },
    });
    const updated = await (tx as any).equipmentRentalBill.update({
      where: { id: bill.id, status: 'PENDING', updatedAt: bill.updatedAt },
      data: {
        paidAmount: amount,
        remainingAmount: 0,
        status: 'PAID',
        confirmedAt: new Date(),
        walletTxId: walletTx.id,
        remark: operatorId ? `管理员手动缴费，操作人：${operatorId}` : bill.remark,
      },
    });
    await this.writeLogTx(tx, {
      operatorId,
      action: operatorId ? 'EQUIPMENT_RENTAL_BILL_ADMIN_PAY' : 'EQUIPMENT_RENTAL_BILL_SELF_PAY',
      targetId: bill.id,
      oldData: bill,
      newData: updated,
      remark: String(remark || '').trim() || (operatorId ? '管理员手动缴纳设备租赁费' : '服务者自行缴纳设备租赁费'),
    });
    return updated;
  }

  async confirmMyBill(userId: number, billId: number) {
    if (!userId || !billId) throw new BadRequestException('参数非法');
    return this.prisma.$transaction(async (tx) => {
      const bill = await (tx as any).equipmentRentalBill.findUnique({ where: { id: billId } });
      if (!bill || Number(bill.userId) !== Number(userId)) throw new NotFoundException('设备租赁账单不存在');
      if (bill.status !== 'PENDING') throw new BadRequestException('该账单无需重复确认');
      await this.assertBillReadyForPayment(tx, bill);
      return this.payBillInTx(tx, bill);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async payBillByAdmin(billId: number, operatorId?: number, remark?: string) {
    const id = Number(billId);
    if (!id) throw new BadRequestException('billId 必填');
    return this.prisma.$transaction(async (tx) => {
      const bill = await (tx as any).equipmentRentalBill.findUnique({ where: { id } });
      if (!bill) throw new NotFoundException('设备租赁账单不存在');
      if (bill.status !== 'PENDING') throw new BadRequestException('该账单无需重复缴费');
      await this.assertBillReadyForPayment(tx, bill);
      return this.payBillInTx(tx, bill, operatorId, String(remark || '').trim() || `管理员手动缴纳设备租赁费 ${bill.billMonth}`);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async prepareStaffExitSettlementTx(
    tx: PrismaTx,
    userId: number,
    operatorId: number | undefined,
    exitAt = new Date(),
  ) {
    const shanghaiDate = new Date(exitAt.getTime() + 8 * 60 * 60 * 1000);
    const cutoffDate = new Date(Date.UTC(
      shanghaiDate.getUTCFullYear(),
      shanghaiDate.getUTCMonth(),
      shanghaiDate.getUTCDate(),
    ));
    const billMonth = this.formatMonth(cutoffDate);
    const contracts = await (tx as any).equipmentRentalContract.findMany({
      where: { userId, status: 'ACTIVE' },
      orderBy: { id: 'asc' },
    });

    const generatedBillIds: number[] = [];
    for (const contract of contracts) {
      const segments = await this.getBillingSegments(tx, contract, billMonth, cutoffDate);
      for (const terms of segments) {
        const { billingSlot } = terms;
        const amount = this.toAmount(terms.amount);
        const existing = await (tx as any).equipmentRentalBill.findUnique({
          where: { contractId_billMonth_billingSlot: { contractId: contract.id, billMonth, billingSlot } },
        });
        const previousPaid = this.toAmount(existing?.paidAmount || 0);
        const paidAmount = existing?.walletTxId ? previousPaid : Math.min(previousPaid, amount);
        if (paidAmount > amount) {
          throw new BadRequestException(`设备费账单 #${existing.id} 已缴金额超过退店截止日应缴金额，请先处理退费`);
        }
        const remainingAmount = round2(Math.max(0, amount - paidAmount));
        const status = remainingAmount > 0 ? 'PENDING' : existing?.status === 'WAIVED' ? 'WAIVED' : 'PAID';
        const bill = existing
          ? await (tx as any).equipmentRentalBill.update({
              where: { id: existing.id },
              data: {
                periodStart: terms.periodStart,
                periodEnd: terms.periodEnd,
                amount,
                paidAmount,
                remainingAmount,
                status,
                dueAt: cutoffDate,
                generatedAt: exitAt,
              },
            })
          : await (tx as any).equipmentRentalBill.create({
              data: {
                contractId: contract.id,
                userId,
                billMonth,
                billingSlot,
                periodStart: terms.periodStart,
                periodEnd: terms.periodEnd,
                amount,
                paidAmount: 0,
                remainingAmount: amount,
                status: amount > 0 ? 'PENDING' : 'PAID',
                dueAt: cutoffDate,
                generatedAt: exitAt,
                remark: '退店时按实际使用天数结算',
              },
            });
        generatedBillIds.push(Number(bill.id));
        await this.writeLogTx(tx, {
          operatorId,
          action: existing ? 'EQUIPMENT_RENTAL_EXIT_BILL_UPDATE' : 'EQUIPMENT_RENTAL_EXIT_BILL_CREATE',
          targetId: bill.id,
          oldData: existing || null,
          newData: bill,
          remark: `退店即时结算设备使用费，截止 ${this.toDateOnlyString(cutoffDate)}`,
        });
      }
    }

    const bills = await (tx as any).equipmentRentalBill.findMany({
      where: { userId, status: 'PENDING', remainingAmount: { gt: 0 } },
      orderBy: [{ billMonth: 'asc' }, { id: 'asc' }],
    });
    return {
      cutoffDate,
      billMonth,
      generatedBillIds,
      bills,
      totalAmount: round2(bills.reduce((sum: number, bill: any) => sum + Number(bill.remainingAmount || 0), 0)),
    };
  }

  async collectStaffExitSettlementTx(
    tx: PrismaTx,
    params: { userId: number; billIds: number[]; operatorId?: number; cutoffDate: Date },
  ) {
    const paidBillIds: number[] = [];
    for (const billId of params.billIds) {
      const bill = await (tx as any).equipmentRentalBill.findUnique({ where: { id: billId } });
      if (!bill || Number(bill.userId) !== Number(params.userId)) continue;
      if (bill.status !== 'PENDING' || Number(bill.remainingAmount || 0) <= 0) continue;
      await this.assertBillReadyForPayment(tx, bill, params.cutoffDate);
      await this.payBillInTx(tx as any, bill, params.operatorId, '退店时自动结清设备使用费');
      paidBillIds.push(Number(bill.id));
    }
    await (tx as any).equipmentRentalContract.updateMany({
      where: { userId: params.userId, status: 'ACTIVE' },
      data: {
        status: 'INACTIVE',
        endDate: params.cutoffDate,
        endMonth: this.formatMonth(params.cutoffDate),
      },
    });
    return { paidBillIds };
  }

  async confirmPaidByOtherChannel(billId: number, operatorId?: number, remark?: string, amountInput?: any) {
    const id = Number(billId);
    if (!id) throw new BadRequestException('billId 必填');
    const normalizedRemark = String(remark || '').trim();
    if (!normalizedRemark) {
      throw new BadRequestException('请填写其他渠道缴费说明');
    }

    return this.prisma.$transaction(async (tx) => {
      const bill = await (tx as any).equipmentRentalBill.findUnique({ where: { id } });
      if (!bill) throw new NotFoundException('设备租赁账单不存在');
      if (bill.status !== 'PENDING') throw new BadRequestException('该账单无需重复确认');
      await this.assertBillReadyForPayment(tx, bill);

      const amount = amountInput === undefined || amountInput === null || amountInput === ''
        ? this.toAmount(bill.remainingAmount)
        : this.toAmount(amountInput);
      if (amount <= 0) throw new BadRequestException('人工确认缴费金额必须大于 0');
      const updated = await (tx as any).equipmentRentalBill.update({
        where: { id, status: 'PENDING', updatedAt: bill.updatedAt },
        data: {
          amount,
          paidAmount: amount,
          remainingAmount: 0,
          status: 'PAID',
          confirmedAt: new Date(),
          walletTxId: null,
          remark: `其他渠道已缴费，操作人：${operatorId || '-'}；${normalizedRemark}`,
        },
      });
      await this.writeLogTx(tx, {
        operatorId,
        action: 'EQUIPMENT_RENTAL_BILL_EXTERNAL_PAY',
        targetId: id,
        oldData: bill,
        newData: updated,
        remark: normalizedRemark,
      });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async refundBill(billId: number, amountInput: any, remark?: string, operatorId?: number) {
    const id = Number(billId);
    if (!id) throw new BadRequestException('billId 必填');
    if (!operatorId) throw new BadRequestException('无法识别操作人');
    const amount = this.toAmount(amountInput);
    if (amount <= 0) throw new BadRequestException('退费金额必须大于 0');
    const normalizedRemark = String(remark || '').trim();
    if (!normalizedRemark) throw new BadRequestException('退费原因必填');

    return this.prisma.$transaction(async (tx) => {
      await (tx as any).$queryRawUnsafe(
        'SELECT id FROM `equipment_rental_bills` WHERE id = ? FOR UPDATE',
        id,
      );
      const bill = await (tx as any).equipmentRentalBill.findUnique({
        where: { id },
        include: {
          walletTx: {
            include: {
              reversals: { where: { direction: 'IN' }, select: { amount: true, status: true } },
            },
          },
        },
      });
      if (!bill) throw new NotFoundException('设备租赁账单不存在');
      if (!bill.walletTxId || !bill.walletTx) {
        throw new BadRequestException('该账单没有钱包支付流水，不能办理退费');
      }
      const adminPayLog = await (tx as any).userLog.findFirst({
        where: {
          targetType: 'EQUIPMENT_RENTAL_BILL',
          targetId: id,
          action: 'EQUIPMENT_RENTAL_BILL_ADMIN_PAY',
        },
        select: { id: true },
      });
      if (bill.walletTx.sourceType === 'EQUIPMENT_RENTAL_BILL_ADMIN_PAY' || adminPayLog) {
        throw new BadRequestException('仅服务者自行确认扣缴的设备费可以退费');
      }
      if (
        bill.walletTx.direction !== 'OUT'
        || bill.walletTx.bizType !== 'EQUIPMENT_RENTAL_FEE'
        || bill.walletTx.status === 'REVERSED'
      ) {
        throw new BadRequestException('原支付流水状态异常，不能办理退费');
      }
      const refunded = round2(
        (bill.walletTx.reversals || [])
          .filter((item: any) => item.status !== 'REVERSED')
          .reduce((sum: number, item: any) => sum + Number(item.amount || 0), 0),
      );
      const refundable = round2(Math.min(
        Math.max(0, Number(bill.walletTx.amount || 0) - refunded),
        Math.max(0, Number(bill.paidAmount || 0)),
      ));
      if (amount > refundable) {
        throw new BadRequestException(`退费金额不能超过可退金额 ¥${refundable.toFixed(2)}`);
      }

      const oldData = {
        id: bill.id,
        amount: bill.amount,
        paidAmount: bill.paidAmount,
        remainingAmount: bill.remainingAmount,
        status: bill.status,
        walletTxId: bill.walletTxId,
        refundedAmount: refunded,
      };
      const audit = await (tx as any).userLog.create({
        data: {
          userId: operatorId,
          action: 'EQUIPMENT_RENTAL_BILL_REFUND',
          targetType: 'EQUIPMENT_RENTAL_BILL',
          targetId: id,
          oldData,
          remark: normalizedRemark,
        },
      });
      const account = await (tx as any).walletAccount.update({
        where: { userId: bill.userId },
        data: { availableBalance: { increment: amount } },
        select: { availableBalance: true, frozenBalance: true },
      });
      const refundTx = await (tx as any).walletTransaction.create({
        data: {
          userId: bill.userId,
          direction: 'IN',
          bizType: 'EQUIPMENT_RENTAL_FEE',
          amount,
          status: 'AVAILABLE',
          sourceType: 'EQUIPMENT_RENTAL_BILL_REFUND',
          sourceId: audit.id,
          reversalOfTxId: bill.walletTxId,
          availableAfter: round2(Number(account.availableBalance || 0)),
          frozenAfter: round2(Number(account.frozenBalance || 0)),
          remark: `设备租赁费退费：${normalizedRemark}`,
        },
      });
      const nextPaidAmount = round2(Math.max(0, Number(bill.paidAmount || 0) - amount));
      const nextAmount = round2(Math.max(0, Number(bill.amount || 0) - amount));
      const updated = await (tx as any).equipmentRentalBill.update({
        where: { id },
        data: {
          amount: nextAmount,
          paidAmount: nextPaidAmount,
          remainingAmount: 0,
          status: 'PAID',
          remark: `已退费 ¥${amount.toFixed(2)}，操作人：${operatorId}；${normalizedRemark}`,
        },
      });
      await (tx as any).userLog.update({
        where: { id: audit.id },
        data: {
          newData: {
            ...updated,
            refundAmount: amount,
            refundWalletTxId: refundTx.id,
            totalRefundedAmount: round2(refunded + amount),
          },
        },
      });
      return {
        ...updated,
        refundedAmount: round2(refunded + amount),
        refundableAmount: round2(Math.max(0, refundable - amount)),
      };
    });
  }

  async waiveBill(billId: number, remark?: string, operatorId?: number) {
    const id = Number(billId);
    if (!id) throw new BadRequestException('billId 必填');
    return this.prisma.$transaction(async (tx) => {
      const bill = await (tx as any).equipmentRentalBill.findUnique({ where: { id } });
      if (!bill) throw new NotFoundException('设备租赁账单不存在');
      const updated = await (tx as any).equipmentRentalBill.update({
        where: { id },
        data: {
          paidAmount: Number(bill.amount || 0),
          status: 'WAIVED',
          remainingAmount: 0,
          remark: String(remark || '').trim() || '管理员减免设备租赁费',
        },
      });
      await this.writeLogTx(tx, {
        operatorId,
        action: 'EQUIPMENT_RENTAL_BILL_WAIVE',
        targetId: id,
        oldData: bill,
        newData: updated,
        remark: String(remark || '').trim() || '管理员减免设备租赁费',
      });
      return updated;
    });
  }

  async getWithdrawalObligationTx(db: PrismaTx, userId: number) {
    // 提前生成账单只用于展示和方便员工主动缴费。只有进入到期前 24 小时的
    // 账单才需要在提现时预留，避免未来月份的账单提前限制正常提现。
    const withdrawalGuardAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const nextMonth = this.getNextMonth();
    const [billAgg, nextMonthBills, contracts] = await Promise.all([
      (db as any).equipmentRentalBill.aggregate({
        where: {
          userId,
          status: 'PENDING',
          OR: [
            { dueAt: { lte: withdrawalGuardAt } },
            // 兼容历史上没有到期时间的账单，这类账单仍按已到期处理。
            { dueAt: null },
          ],
        },
        _sum: { remainingAmount: true },
      }),
      (db as any).equipmentRentalBill.findMany({
        where: { userId, billMonth: nextMonth, billingSlot: { gte: 0 } },
        select: { id: true, contractId: true },
      }),
      (db as any).equipmentRentalContract.findMany({
        where: { userId, status: 'ACTIVE' },
        select: {
          id: true,
          monthlyAmount: true,
          startMonth: true,
          endMonth: true,
          startDate: true,
          endDate: true,
          status: true,
        },
      }),
    ]);
    const outstanding = this.toAmount(billAgg?._sum?.remainingAmount || 0);
    const generatedContractIds = new Set((nextMonthBills || []).map((bill: any) => Number(bill.contractId)));
    const upcoming = contracts
      .filter((contract: any) => this.isContractEffectiveForMonth(contract, nextMonth))
      .filter((contract: any) => !generatedContractIds.has(Number(contract.id)))
      .filter((contract: any) => this.getBillingSchedule(contract, nextMonth).dueAt.getTime() <= withdrawalGuardAt.getTime())
      .reduce((sum: number, contract: any) => sum + this.toAmount(contract.monthlyAmount), 0);
    return {
      outstanding,
      upcoming: round2(upcoming),
      totalObligation: round2(outstanding + upcoming),
      nextMonth,
    };
  }

  async getWithdrawalRiskPreviewTx(db: PrismaTx, userId: number, asOf = new Date()) {
    const shanghaiDate = new Date(asOf.getTime() + 8 * 60 * 60 * 1000);
    const cutoffDate = new Date(Date.UTC(
      shanghaiDate.getUTCFullYear(),
      shanghaiDate.getUTCMonth(),
      shanghaiDate.getUTCDate(),
    ));
    const billMonth = this.formatMonth(cutoffDate);
    const [billAgg, currentBills, contracts] = await Promise.all([
      (db as any).equipmentRentalBill.aggregate({
        where: { userId, status: 'PENDING', remainingAmount: { gt: 0 } },
        _sum: { remainingAmount: true },
      }),
      (db as any).equipmentRentalBill.findMany({
        where: { userId, billMonth, billingSlot: { gte: 0 } },
        select: { contractId: true },
      }),
      (db as any).equipmentRentalContract.findMany({
        where: { userId, status: 'ACTIVE' },
      }),
    ]);
    const billedContractIds = new Set((currentBills || []).map((bill: any) => Number(bill.contractId)));
    const unbilledSegments = await Promise.all((contracts || [])
      .filter((contract: any) => !billedContractIds.has(Number(contract.id)))
      .map((contract: any) => this.getBillingSegments(db, contract, billMonth, cutoffDate)));
    const estimatedAmount = round2(unbilledSegments.flat().reduce((sum, segment) => sum + segment.amount, 0));
    const outstandingAmount = this.toAmount(billAgg?._sum?.remainingAmount || 0);
    return {
      outstandingAmount,
      estimatedAmount,
      totalRiskAmount: round2(outstandingAmount + estimatedAmount),
      billMonth,
      cutoffDate,
      contractCount: contracts?.length || 0,
    };
  }
}
