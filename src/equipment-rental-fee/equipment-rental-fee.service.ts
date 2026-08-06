import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, PrismaClient, StaffEmploymentStatus, UserType } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { round2 } from '../utils/money/format';

type PrismaTx = PrismaClient | Prisma.TransactionClient;

const BILLABLE_STAFF_STATUSES = [StaffEmploymentStatus.ACTIVE, StaffEmploymentStatus.FROZEN] as const;
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

  private getLastDayOfMonth(year: number, zeroBasedMonth: number) {
    return new Date(Date.UTC(year, zeroBasedMonth + 1, 0)).getUTCDate();
  }

  private addMonthsClamped(date: Date, months: number) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + months;
    const targetFirst = new Date(Date.UTC(year, month, 1));
    const day = Math.min(date.getUTCDate(), this.getLastDayOfMonth(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth()));
    return new Date(Date.UTC(targetFirst.getUTCFullYear(), targetFirst.getUTCMonth(), day));
  }

  private getDueDateForMonth(startDateInput: any, billMonth: string) {
    const startDate = this.normalizeDate(startDateInput, '起租日');
    const [year, mon] = this.normalizeMonth(billMonth).split('-').map(Number);
    const day = Math.min(startDate.getUTCDate(), this.getLastDayOfMonth(year, mon - 1));
    return new Date(Date.UTC(year, mon - 1, day));
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

  private getBillingSchedule(contract: any, billMonth: string) {
    const startDate = this.getContractStartDate(contract);
    const dueAt = this.getDueDateForMonth(startDate, billMonth);
    const periodStart = this.addMonthsClamped(dueAt, -1);
    const periodEnd = new Date(dueAt.getTime() - 1);
    return { startDate, dueAt, periodStart, periodEnd };
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

  private isContractEffectiveForMonth(contract: any, month: string) {
    if (String(contract?.status || '') !== 'ACTIVE') return false;
    const { startDate, periodStart } = this.getBillingSchedule(contract, month);
    const firstDueAt = this.addMonthsClamped(startDate, 1);
    if (this.formatMonth(firstDueAt) > month) return false;
    const endDate = this.getContractEndDate(contract);
    if (endDate && endDate.getTime() < periodStart.getTime()) return false;
    return true;
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

    return (this.prisma as any).equipmentRentalContract.create({
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
  }

  async updateContract(dto: any) {
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

    return (this.prisma as any).equipmentRentalContract.update({
      where: { id },
      data,
      include: { user: { select: { id: true, name: true, phone: true, workMode: true } } },
    });
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

  async generateBillsForMonth(monthInput: string) {
    const month = this.normalizeMonth(monthInput);
    const contracts = await (this.prisma as any).equipmentRentalContract.findMany({
      where: {
        status: 'ACTIVE',
        user: {
          userType: UserType.STAFF,
          staffEmploymentStatus: { in: [...BILLABLE_STAFF_STATUSES] },
        },
      },
    });

    let affected = 0;
    for (const contract of contracts) {
      if (!this.isContractEffectiveForMonth(contract, month)) continue;
      const { periodStart, periodEnd, dueAt } = this.getBillingSchedule(contract, month);
      const amount = this.toAmount(contract.monthlyAmount);
      const existing = await (this.prisma as any).equipmentRentalBill.findUnique({
        where: { userId_billMonth: { userId: contract.userId, billMonth: month } },
        select: { id: true, status: true },
      });
      if (existing && existing.status !== 'PENDING') continue;
      if (existing) {
        await (this.prisma as any).equipmentRentalBill.update({
          where: { id: existing.id },
          data: {
            contractId: contract.id,
            periodStart,
            periodEnd,
            amount,
            remainingAmount: amount,
            dueAt,
            generatedAt: new Date(),
          },
        });
      } else {
        await (this.prisma as any).equipmentRentalBill.create({
          data: {
          contractId: contract.id,
          userId: contract.userId,
          billMonth: month,
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
      }
      affected += 1;
    }
    return { month, affected };
  }

  @Cron('0 10 1 * * *', { timeZone: 'Asia/Shanghai' })
  async cronGenerateCurrentMonthBills() {
    await this.generateBillsForMonth(this.getCurrentMonth());
  }

  async listBills(query: any) {
    const page = Math.max(1, Number(query?.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query?.limit ?? 20)));
    const where: any = {};
    if (query?.billMonth) where.billMonth = this.normalizeMonth(query.billMonth);
    if (query?.status) where.status = String(query.status);
    if (query?.userId) where.userId = Number(query.userId);
    if (query?.onlyRisk) where.status = 'PENDING';

    const [rows, total] = await this.prisma.$transaction([
      (this.prisma as any).equipmentRentalBill.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ billMonth: 'desc' }, { id: 'desc' }],
        include: {
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
      }),
      (this.prisma as any).equipmentRentalBill.count({ where }),
    ]);

    const list = rows.map((row: any) => {
      const available = Number(row?.user?.walletAccount?.availableBalance || 0);
      const frozen = Number(row?.user?.walletAccount?.frozenBalance || 0);
      const totalAssets = round2(available + frozen);
      const remaining = Number(row?.remainingAmount || 0);
      return {
        ...row,
        totalAssets,
        insufficient: row.status === 'PENDING' && totalAssets < remaining,
      };
    });
    return { list, total, page, limit };
  }

  async listMyBills(userId: number) {
    return (this.prisma as any).equipmentRentalBill.findMany({
      where: { userId, status: 'PENDING' },
      orderBy: [{ billMonth: 'asc' }, { id: 'asc' }],
    });
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
        sourceType: 'EQUIPMENT_RENTAL_BILL',
        sourceId: bill.id,
        availableAfter: round2(Number(after.availableBalance || 0)),
        frozenAfter: round2(Number(after.frozenBalance || 0)),
        remark: String(remark || '').trim() || `设备租赁费 ${bill.billMonth}`,
      },
    });
    return (tx as any).equipmentRentalBill.update({
      where: { id: bill.id },
      data: {
        paidAmount: amount,
        remainingAmount: 0,
        status: 'PAID',
        confirmedAt: new Date(),
        walletTxId: walletTx.id,
        remark: operatorId ? `管理员手动缴费，操作人：${operatorId}` : bill.remark,
      },
    });
  }

  async confirmMyBill(userId: number, billId: number) {
    if (!userId || !billId) throw new BadRequestException('参数非法');
    return this.prisma.$transaction(async (tx) => {
      const bill = await (tx as any).equipmentRentalBill.findUnique({ where: { id: billId } });
      if (!bill || Number(bill.userId) !== Number(userId)) throw new NotFoundException('设备租赁账单不存在');
      if (bill.status !== 'PENDING') throw new BadRequestException('该账单无需重复确认');
      return this.payBillInTx(tx, bill);
    });
  }

  async payBillByAdmin(billId: number, operatorId?: number, remark?: string) {
    const id = Number(billId);
    if (!id) throw new BadRequestException('billId 必填');
    return this.prisma.$transaction(async (tx) => {
      const bill = await (tx as any).equipmentRentalBill.findUnique({ where: { id } });
      if (!bill) throw new NotFoundException('设备租赁账单不存在');
      if (bill.status !== 'PENDING') throw new BadRequestException('该账单无需重复缴费');
      return this.payBillInTx(tx, bill, operatorId, String(remark || '').trim() || `管理员手动缴纳设备租赁费 ${bill.billMonth}`);
    });
  }

  async confirmPaidByOtherChannel(billId: number, operatorId?: number, remark?: string) {
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

      const amount = this.toAmount(bill.remainingAmount);
      return (tx as any).equipmentRentalBill.update({
        where: { id },
        data: {
          paidAmount: amount,
          remainingAmount: 0,
          status: 'PAID',
          confirmedAt: new Date(),
          walletTxId: null,
          remark: `其他渠道已缴费，操作人：${operatorId || '-'}；${normalizedRemark}`,
        },
      });
    });
  }

  async waiveBill(billId: number, remark?: string) {
    const id = Number(billId);
    if (!id) throw new BadRequestException('billId 必填');
    return (this.prisma as any).equipmentRentalBill.update({
      where: { id },
      data: {
        status: 'WAIVED',
        remainingAmount: 0,
        remark: String(remark || '').trim() || '管理员减免设备租赁费',
      },
    });
  }

  async getWithdrawalObligationTx(db: PrismaTx, userId: number) {
    const nextMonth = this.getNextMonth();
    const [billAgg, nextMonthBill, contracts] = await Promise.all([
      (db as any).equipmentRentalBill.aggregate({
        where: { userId, status: 'PENDING' },
        _sum: { remainingAmount: true },
      }),
      (db as any).equipmentRentalBill.findUnique({
        where: { userId_billMonth: { userId, billMonth: nextMonth } },
        select: { id: true },
      }),
      (db as any).equipmentRentalContract.findMany({
        where: { userId, status: 'ACTIVE' },
        select: { monthlyAmount: true, startMonth: true, endMonth: true, status: true },
      }),
    ]);
    const outstanding = this.toAmount(billAgg?._sum?.remainingAmount || 0);
    const upcoming = nextMonthBill
      ? 0
      : contracts
        .filter((contract: any) => this.isContractEffectiveForMonth(contract, nextMonth))
        .reduce((sum: number, contract: any) => sum + this.toAmount(contract.monthlyAmount), 0);
    return {
      outstanding,
      upcoming: round2(upcoming),
      totalObligation: round2(outstanding + upcoming),
      nextMonth,
    };
  }
}
