import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, PrismaClient, StaffEmploymentStatus, UserType } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { QueryOfflineFeeBillsDto } from './dto/query-offline-fee-bills.dto';
import { ManualCreateOfflineFeeBillDto } from './dto/manual-create-offline-fee-bill.dto';
import { UpdateOfflineFeeBillDto } from './dto/update-offline-fee-bill.dto';

const WITHDRAWAL_PARTIAL_MIN_PAY = 100;
const BILLABLE_STAFF_EMPLOYMENT_STATUSES = [
  StaffEmploymentStatus.ACTIVE,
  StaffEmploymentStatus.FROZEN,
] as const;

type PrismaTx = PrismaClient | Prisma.TransactionClient;

@Injectable()
export class OfflineFeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  private toFixed2(value: number) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  private getMonthRange(month: string) {
    const [yearStr, monthStr] = month.split('-');
    const year = Number(yearStr);
    const mon = Number(monthStr);
    if (!Number.isFinite(year) || !Number.isFinite(mon) || mon < 1 || mon > 12) {
      throw new BadRequestException('month 参数格式应为 YYYY-MM');
    }

    const start = new Date(Date.UTC(year, mon - 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(year, mon, 0, 0, 0, 0));
    return { start, end };
  }

  private parseDateTime(value: any, fieldName = '扣费时间') {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${fieldName}格式不正确`);
    return date;
  }

  private normalizeManualAmount(value: any) {
    const amount = this.toFixed2(Number(value || 0));
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('扣费金额必须大于 0');
    return amount;
  }

  private normalizeMonth(month: any) {
    const value = String(month || '').trim();
    if (!/^\d{4}-\d{2}$/.test(value)) throw new BadRequestException('月份格式必须为 YYYY-MM');
    const [, m] = value.split('-').map(Number);
    if (m < 1 || m > 12) throw new BadRequestException('月份格式必须为 YYYY-MM');
    return value;
  }

  private formatMonth(date: Date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private getCurrentMonth(ref = new Date()) {
    return this.formatMonth(ref);
  }

  private getMonthlyDueAt(monthInput: string) {
    const [year, mon] = this.normalizeMonth(monthInput).split('-').map(Number);
    return new Date(Date.UTC(year, mon - 1, 20, 0, 0, 0));
  }

  private isContractEffectiveForMonth(contract: any, month: string) {
    if (String(contract?.status || '') !== 'ACTIVE') return false;
    const normalizedMonth = this.normalizeMonth(month);
    if (String(contract?.startMonth || '') > normalizedMonth) return false;
    if (contract?.endMonth && String(contract.endMonth) < normalizedMonth) return false;
    return true;
  }

  private async writeLogTx(db: PrismaTx, params: {
    operatorId?: number;
    action: string;
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
        targetType: 'OFFLINE_FEE_BILL',
        targetId: params.targetId ?? null,
        oldData: params.oldData ?? undefined,
        newData: params.newData ?? undefined,
        remark: params.remark ?? null,
      },
    });
  }

  async listContracts(query: any) {
    const page = Math.max(1, Number(query?.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query?.limit ?? 20)));
    const where: any = {};
    if (query?.status) where.status = String(query.status);
    if (query?.userId) where.userId = Number(query.userId);
    const [list, total] = await this.prisma.$transaction([
      (this.prisma as any).offlineFeeContract.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ id: 'desc' }],
        include: { user: { select: { id: true, name: true, realName: true, phone: true, workMode: true, staffEmploymentStatus: true } } },
      }),
      (this.prisma as any).offlineFeeContract.count({ where }),
    ]);
    return { list, total, page, limit };
  }

  async createContract(dto: any, operatorId?: number) {
    const userId = Number(dto?.userId);
    const monthlyAmount = this.normalizeManualAmount(dto?.monthlyAmount);
    const startMonth = this.normalizeMonth(dto?.startMonth);
    const endMonth = dto?.endMonth ? this.normalizeMonth(dto.endMonth) : null;
    if (!userId) throw new BadRequestException('请选择线下服务者');
    if (endMonth && endMonth < startMonth) throw new BadRequestException('结束月份不能早于开始月份');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, userType: true, workMode: true, staffEmploymentStatus: true },
    });
    if (!user) throw new NotFoundException('服务者不存在');
    if (
      user.userType !== UserType.STAFF ||
      user.workMode !== 'OFFLINE' ||
      !BILLABLE_STAFF_EMPLOYMENT_STATUSES.map(String).includes(String(user.staffEmploymentStatus))
    ) {
      throw new BadRequestException('仅支持为未退店、未拉黑的线下服务者配置线下管理费');
    }

    return this.prisma.$transaction(async (tx) => {
      const contract = await (tx as any).offlineFeeContract.create({
        data: {
          userId,
          monthlyAmount,
          startMonth,
          endMonth,
          status: String(dto?.status || 'ACTIVE') === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
          remark: String(dto?.remark || '').trim() || null,
          createdBy: operatorId ?? null,
        },
        include: { user: { select: { id: true, name: true, realName: true, phone: true, workMode: true, staffEmploymentStatus: true } } },
      });
      if (operatorId) {
        await (tx as any).userLog.create({
          data: {
            userId: operatorId,
            action: 'OFFLINE_FEE_CONTRACT_CREATE',
            targetType: 'OFFLINE_FEE_CONTRACT',
            targetId: contract.id,
            newData: contract,
            remark: '新增线下管理费配置',
          },
        });
      }
      return contract;
    });
  }

  async updateContract(dto: any, operatorId?: number) {
    const id = Number(dto?.id);
    if (!id) throw new BadRequestException('id 必填');
    const existing = await (this.prisma as any).offlineFeeContract.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('线下管理费配置不存在');
    const data: any = {};
    if (dto?.monthlyAmount !== undefined) data.monthlyAmount = this.normalizeManualAmount(dto.monthlyAmount);
    if (dto?.startMonth !== undefined) data.startMonth = this.normalizeMonth(dto.startMonth);
    if (dto?.endMonth !== undefined) data.endMonth = dto.endMonth ? this.normalizeMonth(dto.endMonth) : null;
    if (dto?.status !== undefined) data.status = String(dto.status) === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
    if (dto?.remark !== undefined) data.remark = String(dto.remark || '').trim() || null;
    const nextStart = data.startMonth ?? existing.startMonth;
    const nextEnd = data.endMonth !== undefined ? data.endMonth : existing.endMonth;
    if (nextEnd && nextEnd < nextStart) throw new BadRequestException('结束月份不能早于开始月份');
    return this.prisma.$transaction(async (tx) => {
      const updated = await (tx as any).offlineFeeContract.update({
        where: { id },
        data,
        include: { user: { select: { id: true, name: true, realName: true, phone: true, workMode: true, staffEmploymentStatus: true } } },
      });
      if (operatorId) {
        await (tx as any).userLog.create({
          data: {
            userId: operatorId,
            action: 'OFFLINE_FEE_CONTRACT_UPDATE',
            targetType: 'OFFLINE_FEE_CONTRACT',
            targetId: id,
            oldData: existing,
            newData: updated,
            remark: '编辑线下管理费配置',
          },
        });
      }
      return updated;
    });
  }

  private getPreviousMonth(refDate = new Date()) {
    const year = refDate.getUTCFullYear();
    const month = refDate.getUTCMonth();
    const target = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
    const y = target.getUTCFullYear();
    const m = `${target.getUTCMonth() + 1}`.padStart(2, '0');
    return `${y}-${m}`;
  }

  private async getFeeConfig(db: PrismaTx) {
    await this.systemConfigService.ensureDefaults();

    const keys = [
      SystemConfigService.KEYS.OFFLINE_FEE_RATE,
      SystemConfigService.KEYS.OFFLINE_FEE_MIN,
      SystemConfigService.KEYS.OFFLINE_FEE_CAP,
      SystemConfigService.KEYS.OFFLINE_FEE_PARTIAL_MIN_PAY,
    ];

    const rows = await (db as any).systemConfig.findMany({ where: { key: { in: keys } } });
    const map = new Map<string, any>(rows.map((r: any) => [r.key, r]));

    const rate = Number(map.get(SystemConfigService.KEYS.OFFLINE_FEE_RATE)?.value ?? '0.1');
    const minAmount = Number(map.get(SystemConfigService.KEYS.OFFLINE_FEE_MIN)?.value ?? '100');
    const capAmount = Number(map.get(SystemConfigService.KEYS.OFFLINE_FEE_CAP)?.value ?? '3000');
    const partialMinPay = Number(map.get(SystemConfigService.KEYS.OFFLINE_FEE_PARTIAL_MIN_PAY)?.value ?? '100');

    return {
      rate: Number.isFinite(rate) ? rate : 0.1,
      minAmount: Number.isFinite(minAmount) ? minAmount : 100,
      capAmount: Number.isFinite(capAmount) ? capAmount : 3000,
      partialMinPay: Number.isFinite(partialMinPay) ? partialMinPay : 100,
    };
  }

  private calcJoinedRatio(offlineJoinedAt: Date | null, periodStart: Date, periodEnd: Date) {
    if (!offlineJoinedAt) return 1;

    const joinDate = new Date(Date.UTC(offlineJoinedAt.getUTCFullYear(), offlineJoinedAt.getUTCMonth(), offlineJoinedAt.getUTCDate()));
    if (joinDate > periodEnd) return 0;

    const activeStart = joinDate > periodStart ? joinDate : periodStart;
    const dayMs = 24 * 60 * 60 * 1000;
    const totalDays = Math.floor((periodEnd.getTime() - periodStart.getTime()) / dayMs) + 1;
    const activeDays = Math.floor((periodEnd.getTime() - activeStart.getTime()) / dayMs) + 1;

    if (totalDays <= 0) return 0;
    return Math.max(0, Math.min(1, activeDays / totalDays));
  }

  private calcShouldPay(baseAmount: number, rate: number, minAmount: number, capAmount: number) {
    const raw = this.toFixed2(baseAmount * rate);
    const floor = Math.max(0, minAmount);
    const cap = Math.max(floor, capAmount);
    return this.toFixed2(Math.min(Math.max(raw, floor), cap));
  }

  // 人工录入/人工编辑后，会将 generatedAt 更新为当前时间；
  // 自动任务不会改 generatedAt。由此可识别“该账单曾被人工干预”。
  private isManualAdjustedBill(existing?: {
    createdAt?: Date | null;
    generatedAt?: Date | null;
  } | null) {
    if (!existing?.createdAt || !existing?.generatedAt) return false;
    return existing.generatedAt.getTime() - existing.createdAt.getTime() > 1000;
  }

  async generateBillsForMonth(month: string, operatorId?: number) {
    return this.prisma.$transaction(async (tx) => this.generateBillsForMonthTx(tx as any, month, operatorId));
  }

  private async generateBillsForMonthTx(db: PrismaTx, month: string, operatorId?: number) {
    const { start, end } = this.getMonthRange(month);
    const dueAt = this.getMonthlyDueAt(month);
    const contracts = await (db as any).offlineFeeContract.findMany({
      where: {
        status: 'ACTIVE',
        user: {
          userType: UserType.STAFF,
          workMode: 'OFFLINE',
          staffEmploymentStatus: { in: [...BILLABLE_STAFF_EMPLOYMENT_STATUSES] },
        },
      },
    });

    let affected = 0;

    for (const contract of contracts) {
      if (!this.isContractEffectiveForMonth(contract, month)) continue;
      const amount = this.normalizeManualAmount(contract.monthlyAmount);
      const existing = await (db as any).offlineFeeBill.findUnique({
        where: { userId_billMonth: { userId: contract.userId, billMonth: month } },
        select: { id: true, paidAmount: true, status: true },
      });
      if (existing && !['UNPAID', 'PARTIAL'].includes(String(existing.status || ''))) continue;
      const paid = Number(existing?.paidAmount || 0);
      const finalRemaining = this.toFixed2(Math.max(0, amount - paid));
      const finalStatus = finalRemaining <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';
      const bill = existing
        ? await (db as any).offlineFeeBill.update({
          where: { id: existing.id },
          data: {
            periodStart: start,
            periodEnd: end,
            performanceBaseAmount: amount,
            rate: 1,
            minAmount: 0,
            capAmount: amount,
            shouldPayAmount: amount,
            remainingAmount: finalRemaining,
            status: finalStatus,
            dueAt,
            remark: String(contract.remark || '').trim() || '线下管理费',
            generatedAt: new Date(),
          },
        })
        : await (db as any).offlineFeeBill.create({
          data: {
            userId: contract.userId,
            billMonth: month,
            periodStart: start,
            periodEnd: end,
            performanceBaseAmount: amount,
            rate: 1,
            minAmount: 0,
            capAmount: amount,
            shouldPayAmount: amount,
            paidAmount: 0,
            remainingAmount: amount,
            status: 'UNPAID',
            dueAt,
            remark: String(contract.remark || '').trim() || '线下管理费',
            createdBy: operatorId ?? null,
            generatedAt: new Date(),
          },
        });
      await this.writeLogTx(db, {
        operatorId,
        action: existing ? 'OFFLINE_FEE_BILL_GENERATE_UPDATE' : 'OFFLINE_FEE_BILL_GENERATE_CREATE',
        targetId: bill.id,
        oldData: existing,
        newData: bill,
        remark: `按配置生成线下管理费账单 ${month}`,
      });
      affected += 1;
    }

    return { month, affected };
  }

  @Cron('0 0 20 * * *', { timeZone: 'Asia/Shanghai' })
  async cronGenerateCurrentMonthBills() {
    await this.generateBillsForMonth(this.getCurrentMonth());
  }

  private async legacyGenerateBillsForMonthTx(db: PrismaTx, month: string) {
    const { start, end } = this.getMonthRange(month);
    const cfg = await this.getFeeConfig(db);
    const offlineUsers = await (db as any).user.findMany({
      where: {
        userType: UserType.STAFF,
        workMode: 'OFFLINE',
        staffEmploymentStatus: { in: [...BILLABLE_STAFF_EMPLOYMENT_STATUSES] },
        OR: [{ offlineJoinedAt: null }, { offlineJoinedAt: { lte: end } }],
      },
      select: { id: true, offlineJoinedAt: true },
    });
    let affected = 0;
    for (const user of offlineUsers) {
      const perfAgg = await (db as any).performanceRecord.aggregate({
        where: { ownerUserId: user.id, ownerRoleType: 'PLAYER', status: 'EFFECTIVE', statsDate: { gte: start, lte: end } },
        _sum: { grossPerformanceAmount: true },
      });
      const gross = Number(perfAgg?._sum?.grossPerformanceAmount || 0);
      const ratio = this.calcJoinedRatio(user.offlineJoinedAt, start, end);
      const baseAmount = this.toFixed2(gross * ratio);
      const finalShouldPay = this.calcShouldPay(baseAmount, cfg.rate, cfg.minAmount, cfg.capAmount);
      await (db as any).offlineFeeBill.upsert({
        where: { userId_billMonth: { userId: user.id, billMonth: month } },
        update: {
          periodStart: start,
          periodEnd: end,
          performanceBaseAmount: baseAmount,
          rate: cfg.rate,
          minAmount: cfg.minAmount,
          capAmount: cfg.capAmount,
          shouldPayAmount: finalShouldPay,
          remainingAmount: finalShouldPay,
          status: finalShouldPay > 0 ? 'UNPAID' : 'PAID',
        },
        create: {
          userId: user.id,
          billMonth: month,
          periodStart: start,
          periodEnd: end,
          performanceBaseAmount: baseAmount,
          rate: cfg.rate,
          minAmount: cfg.minAmount,
          capAmount: cfg.capAmount,
          shouldPayAmount: finalShouldPay,
          paidAmount: 0,
          remainingAmount: finalShouldPay,
          status: finalShouldPay > 0 ? 'UNPAID' : 'PAID',
          generatedAt: new Date(),
        },
      });
      affected += 1;
    }
    return { month, affected };
  }

  async listBills(query: QueryOfflineFeeBillsDto) {
    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
    const where: any = {};

    if (query.billMonth) where.billMonth = query.billMonth;
    if (query.status) where.status = query.status;
    if (query.userId) where.userId = Number(query.userId);
    if (query.onlyOutstanding) where.remainingAmount = { gt: 0 };

    const { rows, total, stats } = await this.prisma.$transaction(async (tx) => {
      const scopedRows = await (tx as any).offlineFeeBill.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ billMonth: 'desc' }, { id: 'desc' }],
        include: {
          user: {
            select: { id: true, name: true, phone: true, workMode: true, offlineJoinedAt: true },
          },
          payments: {
            select: { amount: true, source: true },
          },
        },
      });
      const scopedTotal = await (tx as any).offlineFeeBill.count({ where });
      const scopedStats = await this.getBillStatsTx(tx as any, where);
      return { rows: scopedRows, total: scopedTotal, stats: scopedStats };
    });

    const list = rows.map((row: any) => this.attachPaymentStats(row));
    return { list, total, page, limit, stats };
  }

  private attachPaymentStats(row: any) {
    const payments = Array.isArray(row?.payments) ? row.payments : [];
    const manualPaidAmount = this.toFixed2(payments
      .filter((p: any) => ['MANUAL', 'WITHDRAWAL'].includes(String(p.source || '')))
      .reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0));
    const externalPaidAmount = this.toFixed2(payments
      .filter((p: any) => String(p.source || '') === 'EXTERNAL')
      .reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0));
    const waivedAmount = this.toFixed2(payments
      .filter((p: any) => String(p.source || '') === 'WAIVER')
      .reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0));
    return {
      ...row,
      manualPaidAmount,
      externalPaidAmount,
      waivedAmount,
      payments: undefined,
    };
  }

  private async getBillStatsTx(db: PrismaTx, where: any) {
    const rows = await (db as any).offlineFeeBill.findMany({
      where,
      select: { id: true, shouldPayAmount: true, remainingAmount: true, payments: { select: { amount: true, source: true } } },
    });
    const initial = { billAmount: 0, remainingAmount: 0, chargedAmount: 0, externalPaidAmount: 0, waivedAmount: 0 };
    return rows.reduce((acc: any, row: any) => {
      acc.billAmount = this.toFixed2(acc.billAmount + Number(row.shouldPayAmount || 0));
      acc.remainingAmount = this.toFixed2(acc.remainingAmount + Number(row.remainingAmount || 0));
      for (const p of Array.isArray(row.payments) ? row.payments : []) {
        const source = String(p.source || '');
        const amount = Number(p.amount || 0);
        if (source === 'EXTERNAL') acc.externalPaidAmount = this.toFixed2(acc.externalPaidAmount + amount);
        else if (source === 'WAIVER') acc.waivedAmount = this.toFixed2(acc.waivedAmount + amount);
        else acc.chargedAmount = this.toFixed2(acc.chargedAmount + amount);
      }
      return acc;
    }, initial);
  }

  async listOfflineStaffOptions(keyword?: string) {
    const where: any = {
      userType: UserType.STAFF,
      workMode: 'OFFLINE',
      staffEmploymentStatus: { in: [...BILLABLE_STAFF_EMPLOYMENT_STATUSES] },
    };

    const q = String(keyword || '').trim();
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { phone: { contains: q } },
        { realName: { contains: q } },
      ];
      if (/^\d+$/.test(q)) {
        where.OR.push({ id: Number(q) });
      }
    }

    const rows = await this.prisma.user.findMany({
      where,
      take: 100,
      orderBy: [{ id: 'desc' }],
      select: {
        id: true,
        name: true,
        realName: true,
        phone: true,
        status: true,
        offlineJoinedAt: true,
      },
    });

    return rows.map((item) => ({
      id: item.id,
      label: `${item.name || item.realName || item.phone} (${item.phone})`,
      name: item.name,
      realName: item.realName,
      phone: item.phone,
      status: item.status,
      offlineJoinedAt: item.offlineJoinedAt,
    }));
  }

  async manualCreateBill(dto: ManualCreateOfflineFeeBillDto, operatorId?: number) {
    const userId = Number(dto.userId);
    const month = String(dto.month || '').trim();
    const amount = this.normalizeManualAmount(dto.amount ?? dto.performanceBaseAmount);
    const { start, end } = this.getMonthRange(month);
    const dueAt = this.parseDateTime(dto.dueAt) || end;
    const remark = String(dto.remark || '').trim() || null;

    return this.prisma.$transaction(async (tx) => {
      const user = await (tx as any).user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          userType: true,
          workMode: true,
          staffEmploymentStatus: true,
          offlineJoinedAt: true,
        },
      });

      if (!user) throw new NotFoundException('员工不存在');
      if (
        user.userType !== UserType.STAFF ||
        user.workMode !== 'OFFLINE' ||
        !BILLABLE_STAFF_EMPLOYMENT_STATUSES.includes(user.staffEmploymentStatus)
      ) {
        throw new BadRequestException('仅支持为线下员工录入账单');
      }

      // 线下入职日期晚于账单周期时，不允许录入该月份账单
      if (user.offlineJoinedAt) {
        const joinDate = new Date(Date.UTC(
          user.offlineJoinedAt.getUTCFullYear(),
          user.offlineJoinedAt.getUTCMonth(),
          user.offlineJoinedAt.getUTCDate(),
        ));
        if (joinDate > end) {
          throw new BadRequestException('该员工在线下入职时间之后才生效，不能录入该月份账单');
        }
      }

      const existing = await (tx as any).offlineFeeBill.findUnique({
        where: { userId_billMonth: { userId, billMonth: month } },
        select: { id: true, paidAmount: true, shouldPayAmount: true, remainingAmount: true, status: true, dueAt: true, remark: true },
      });

      const paid = Number(existing?.paidAmount || 0);
      const remaining = this.toFixed2(Math.max(0, amount - paid));
      const status = remaining <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';

      const bill = await (tx as any).offlineFeeBill.upsert({
        where: { userId_billMonth: { userId, billMonth: month } },
        update: {
          periodStart: start,
          periodEnd: end,
          performanceBaseAmount: amount,
          rate: 1,
          minAmount: 0,
          capAmount: amount,
          shouldPayAmount: amount,
          remainingAmount: remaining,
          status,
          dueAt,
          remark,
          generatedAt: new Date(),
        },
        create: {
          userId,
          billMonth: month,
          periodStart: start,
          periodEnd: end,
          performanceBaseAmount: amount,
          rate: 1,
          minAmount: 0,
          capAmount: amount,
          shouldPayAmount: amount,
          paidAmount: 0,
          remainingAmount: amount,
          status: 'UNPAID',
          dueAt,
          remark,
          createdBy: operatorId ?? null,
          generatedAt: new Date(),
        },
      });

      await this.writeLogTx(tx as any, {
        operatorId,
        action: existing ? 'OFFLINE_FEE_BILL_UPDATE' : 'OFFLINE_FEE_BILL_CREATE',
        targetId: bill.id,
        oldData: existing,
        newData: bill,
        remark: existing ? '更新线下费用账单配置' : '手动录入线下费用账单',
      });
      return bill;
    });
  }

  async setEnforceFullPayment(billId: number, enforceFullPayment: boolean, operatorId?: number) {
    const bill = await this.prisma.offlineFeeBill.findUnique({ where: { id: billId } });
    if (!bill) throw new NotFoundException('线下费用账单不存在');

    return this.prisma.$transaction(async (tx) => {
      const updated = await (tx as any).offlineFeeBill.update({
        where: { id: billId },
        data: { enforceFullPayment },
      });
      await this.writeLogTx(tx as any, {
        operatorId,
        action: 'OFFLINE_FEE_BILL_ENFORCE_UPDATE',
        targetId: billId,
        oldData: { enforceFullPayment: bill.enforceFullPayment },
        newData: { enforceFullPayment },
        remark: '更新线下费用账单强制全额状态',
      });
      return updated;
    });
  }

  async remindBill(billId: number, operatorId?: number) {
    const bill = await this.prisma.offlineFeeBill.findUnique({ where: { id: billId } });
    if (!bill) throw new NotFoundException('线下费用账单不存在');

    return this.prisma.$transaction(async (tx) => {
      const updated = await (tx as any).offlineFeeBill.update({
        where: { id: billId },
        data: { lastRemindAt: new Date() },
      });
      await this.writeLogTx(tx as any, {
        operatorId,
        action: 'OFFLINE_FEE_BILL_REMIND',
        targetId: billId,
        oldData: { lastRemindAt: bill.lastRemindAt },
        newData: { lastRemindAt: updated.lastRemindAt },
        remark: '记录线下费用账单催收',
      });
      return updated;
    });
  }

  async updateBill(dto: UpdateOfflineFeeBillDto, operatorId?: number) {
    const billId = Number(dto.billId);
    const amount = this.normalizeManualAmount(dto.amount ?? dto.performanceBaseAmount);
    const dueAt = dto.dueAt !== undefined ? this.parseDateTime(dto.dueAt) : undefined;
    const remark = dto.remark !== undefined ? (String(dto.remark || '').trim() || null) : undefined;

    return this.prisma.$transaction(async (tx) => {
      const bill = await (tx as any).offlineFeeBill.findUnique({ where: { id: billId } });
      if (!bill) throw new NotFoundException('线下费用账单不存在');

      const paid = this.toFixed2(Number(bill.paidAmount || 0));
      const remaining = this.toFixed2(Math.max(0, amount - paid));
      const status = remaining <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';

      const updated = await (tx as any).offlineFeeBill.update({
        where: { id: billId },
        data: {
          performanceBaseAmount: amount,
          rate: 1,
          minAmount: 0,
          capAmount: amount,
          shouldPayAmount: amount,
          remainingAmount: remaining,
          status,
          ...(dueAt !== undefined ? { dueAt } : {}),
          ...(remark !== undefined ? { remark } : {}),
          generatedAt: new Date(),
        },
      });
      await this.writeLogTx(tx as any, {
        operatorId,
        action: 'OFFLINE_FEE_BILL_UPDATE',
        targetId: billId,
        oldData: bill,
        newData: updated,
        remark: '编辑线下费用账单配置',
      });
      return updated;
    });
  }

  async waiveBill(params: { billId: number; operatorId?: number; remark?: string }) {
    const billId = Number(params.billId);

    return this.prisma.$transaction(async (tx) => {
      const bill = await (tx as any).offlineFeeBill.findUnique({ where: { id: billId } });
      if (!bill) throw new NotFoundException('线下费用账单不存在');

      const remain = this.toFixed2(Number(bill.remainingAmount || 0));
      const remark = String(params.remark || '').trim() || '管理员减免线下费用';
      if (remain > 0) {
        await (tx as any).offlineFeeBillPayment.create({
          data: {
            billId: bill.id,
            userId: bill.userId,
            amount: remain,
            source: 'WAIVER',
            operatorId: params.operatorId ?? null,
            remark,
          },
        });
      }

      const updated = await (tx as any).offlineFeeBill.update({
        where: { id: billId },
        data: {
          paidAmount: this.toFixed2(Number(bill.paidAmount || 0) + remain),
          remainingAmount: 0,
          status: 'WAIVED',
          enforceFullPayment: false,
          lastRemindAt: null,
          generatedAt: new Date(),
          remark,
        },
      });
      await this.writeLogTx(tx as any, {
        operatorId: params.operatorId,
        action: 'OFFLINE_FEE_BILL_WAIVE',
        targetId: billId,
        oldData: bill,
        newData: updated,
        remark,
      });
      return updated;
    });
  }

  async deleteWaivedBill(params: { billId: number; operatorId?: number }) {
    const billId = Number(params.billId);
    if (!Number.isFinite(billId) || billId <= 0) {
      throw new BadRequestException('无效的线下费用账单 ID');
    }

    return this.prisma.$transaction(async (tx) => {
      const bill = await (tx as any).offlineFeeBill.findUnique({
        where: { id: billId },
        include: {
          payments: {
            select: { id: true },
          },
        },
      });
      if (!bill) throw new NotFoundException('线下费用账单不存在');
      if (String(bill.status || '') !== 'WAIVED') {
        throw new BadRequestException('仅已废除的线下费用账单可以删除');
      }
      if (Array.isArray(bill.payments) && bill.payments.length > 0) {
        throw new BadRequestException('账单存在缴费记录，不允许删除');
      }

      await (tx as any).offlineFeeBill.delete({ where: { id: billId } });
      await this.writeLogTx(tx as any, {
        operatorId: params.operatorId,
        action: 'OFFLINE_FEE_BILL_DELETE',
        targetId: billId,
        oldData: bill,
        remark: '删除已废除线下费用账单',
      });
      return { success: true, billId };
    });
  }

  async batchDeleteBills(params: { billIds: number[]; operatorId?: number }) {
    const billIds = Array.from(new Set(
      (Array.isArray(params.billIds) ? params.billIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ));

    if (billIds.length === 0) {
      throw new BadRequestException('请选择需要删除的线下费用账单');
    }
    if (billIds.length > 200) {
      throw new BadRequestException('单次最多删除 200 条线下费用账单');
    }

    return this.prisma.$transaction(async (tx) => {
      const bills = await (tx as any).offlineFeeBill.findMany({
        where: { id: { in: billIds } },
        include: {
          user: { select: { id: true, name: true, phone: true } },
          payments: { select: { id: true } },
        },
      });

      const foundIds = new Set<number>(bills.map((bill: any) => Number(bill.id)));
      const notFoundBillIds = billIds.filter((id) => !foundIds.has(id));
      const blockedBills = bills.filter((bill: any) => Array.isArray(bill.payments) && bill.payments.length > 0);
      const blockedBillIds = blockedBills.map((bill: any) => Number(bill.id));
      const deletableBills = bills.filter((bill: any) => !(Array.isArray(bill.payments) && bill.payments.length > 0));
      const deletableIds = deletableBills.map((bill: any) => Number(bill.id));

      if (deletableIds.length > 0) {
        await (tx as any).offlineFeeBill.deleteMany({
          where: { id: { in: deletableIds } },
        });

        for (const bill of deletableBills) {
          await this.writeLogTx(tx as any, {
            operatorId: params.operatorId,
            action: 'OFFLINE_FEE_BILL_BATCH_DELETE',
            targetId: Number(bill.id),
            oldData: bill,
            remark: '批量删除历史错误线下费用账单',
          });
        }
      }

      return {
        success: true,
        requested: billIds.length,
        deleted: deletableIds.length,
        skipped: blockedBillIds.length + notFoundBillIds.length,
        deletedBillIds: deletableIds,
        blockedBillIds,
        notFoundBillIds,
      };
    });
  }

  private async getLastMonthOutstandingBillTx(db: PrismaTx, userId: number, now = new Date()) {
    const user = await (db as any).user.findUnique({
      where: { id: userId },
      select: {
        userType: true,
        workMode: true,
        staffEmploymentStatus: true,
      },
    });
    const isBillableOfflineStaff =
      user?.userType === UserType.STAFF &&
      user?.workMode === 'OFFLINE' &&
      BILLABLE_STAFF_EMPLOYMENT_STATUSES.includes(user?.staffEmploymentStatus);
    if (!isBillableOfflineStaff) {
      return null;
    }

    // 与设备租赁一致：已有未结清账单且进入到期前 24 小时，才影响提现。
    const withdrawalGuardAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return (db as any).offlineFeeBill.findFirst({
      where: {
        userId,
        remainingAmount: { gt: 0 },
        status: { in: ['UNPAID', 'PARTIAL'] },
        OR: [
          { dueAt: { lte: withdrawalGuardAt } },
          { dueAt: null },
        ],
      },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    });
  }

  async getWithdrawalGuardInfo(userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const bill = await this.getLastMonthOutstandingBillTx(tx as any, userId);
      const account = await (tx as any).walletAccount.findUnique({
        where: { userId },
        select: { availableBalance: true, frozenBalance: true },
      });

      const availableBalance = this.toFixed2(Number(account?.availableBalance || 0));
      const frozenBalance = this.toFixed2(Number(account?.frozenBalance || 0));
      const walletTotal = this.toFixed2(availableBalance + frozenBalance);

      if (!bill) {
        return {
          hasOutstanding: false,
          partialMinPay: WITHDRAWAL_PARTIAL_MIN_PAY,
          bill: null,
          availableBalance,
          frozenBalance,
          walletTotal,
          canPartialPayByWalletRule: true,
        };
      }

      const remaining = Number(bill.remainingAmount || 0);
      const effectivePartialMinPay = this.toFixed2(Math.max(0, Math.min(WITHDRAWAL_PARTIAL_MIN_PAY, remaining)));
      return {
        hasOutstanding: remaining > 0,
        partialMinPay: effectivePartialMinPay,
        bill,
        availableBalance,
        frozenBalance,
        walletTotal,
        // 规则：若要部分缴纳，缴后剩余钱包总额度(含冻结)需大于剩余未缴。
        // 该不等式可约简为：当前钱包总额度 > 当前未缴额度。
        canPartialPayByWalletRule: walletTotal > this.toFixed2(remaining),
      };
    });
  }

  async collectByWalletBalance(params: {
    billId: number;
    amount: number;
    operatorId?: number;
    remark?: string;
  }) {
    const { billId, amount, operatorId, remark } = params;

    if (!amount || Number(amount) <= 0) {
      throw new BadRequestException('缴费金额必须大于 0');
    }

    return this.prisma.$transaction(async (tx) => {
      const bill = await (tx as any).offlineFeeBill.findUnique({ where: { id: billId } });
      if (!bill) throw new NotFoundException('线下费用账单不存在');

      const remain = Number(bill.remainingAmount || 0);
      if (remain <= 0) throw new BadRequestException('该账单已结清');

      const payAmount = this.toFixed2(Math.min(remain, Number(amount)));

      const account = await (tx as any).walletAccount.findUnique({ where: { userId: bill.userId } });
      if (!account) throw new BadRequestException('钱包账户不存在');

      const available = Number(account.availableBalance || 0);
      if (available < payAmount) {
        throw new BadRequestException('可用余额不足，无法缴纳线下运营成本');
      }

      const after = await (tx as any).walletAccount.update({
        where: { userId: bill.userId },
        data: { availableBalance: { decrement: payAmount } },
        select: { availableBalance: true, frozenBalance: true },
      });

      const payment = await (tx as any).offlineFeeBillPayment.create({
        data: {
          billId: bill.id,
          userId: bill.userId,
          amount: payAmount,
          source: 'MANUAL',
          operatorId: operatorId ?? null,
          remark: remark ?? null,
        },
      });

      await (tx as any).walletTransaction.create({
        data: {
          userId: bill.userId,
          direction: 'OUT',
          bizType: 'OFFLINE_FEE_PAYMENT',
          amount: payAmount,
          status: 'AVAILABLE',
          sourceType: 'OFFLINE_FEE_PAYMENT',
          sourceId: payment.id,
          availableAfter: this.toFixed2(Number(after.availableBalance || 0)),
          frozenAfter: this.toFixed2(Number(after.frozenBalance || 0)),
        },
      });

      const updated = await this.refreshBillPaymentStatusTx(tx as any, bill.id);
      await this.writeLogTx(tx as any, {
        operatorId,
        action: 'OFFLINE_FEE_BILL_MANUAL_PAY',
        targetId: bill.id,
        oldData: bill,
        newData: { payment, bill: updated },
        remark: remark || '手动缴纳线下费用',
      });
      return updated;
    });
  }

  async confirmPaidByOtherChannel(params: {
    billId: number;
    amount?: number;
    operatorId?: number;
    remark?: string;
  }) {
    const billId = Number(params.billId);
    const normalizedRemark = String(params.remark || '').trim();
    if (!normalizedRemark) throw new BadRequestException('请填写其他渠道收款说明');
    return this.prisma.$transaction(async (tx) => {
      const bill = await (tx as any).offlineFeeBill.findUnique({ where: { id: billId } });
      if (!bill) throw new NotFoundException('线下费用账单不存在');
      const remain = Number(bill.remainingAmount || 0);
      if (remain <= 0) throw new BadRequestException('该账单已结清');
      const payAmount = this.toFixed2(Math.min(remain, Number(params.amount || remain)));
      if (payAmount <= 0) throw new BadRequestException('收款金额必须大于 0');
      const payment = await (tx as any).offlineFeeBillPayment.create({
        data: {
          billId: bill.id,
          userId: bill.userId,
          amount: payAmount,
          source: 'EXTERNAL',
          operatorId: params.operatorId ?? null,
          remark: normalizedRemark,
        },
      });
      const updated = await this.refreshBillPaymentStatusTx(tx as any, bill.id);
      await this.writeLogTx(tx as any, {
        operatorId: params.operatorId,
        action: 'OFFLINE_FEE_BILL_EXTERNAL_PAY',
        targetId: bill.id,
        oldData: bill,
        newData: { payment, bill: updated },
        remark: normalizedRemark,
      });
      return updated;
    });
  }

  private async refreshBillPaymentStatusTx(db: PrismaTx, billId: number) {
    const bill = await (db as any).offlineFeeBill.findUnique({ where: { id: billId } });
    if (!bill) throw new NotFoundException('线下费用账单不存在');

    const agg = await (db as any).offlineFeeBillPayment.aggregate({
      where: { billId },
      _sum: { amount: true },
    });

    const paid = this.toFixed2(Number(agg?._sum?.amount || 0));
    const shouldPay = Number(bill.shouldPayAmount || 0);
    const remaining = this.toFixed2(Math.max(0, shouldPay - paid));
    const status = remaining <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';

    return (db as any).offlineFeeBill.update({
      where: { id: billId },
      data: {
        paidAmount: paid,
        remainingAmount: remaining,
        status,
      },
    });
  }

  async validateAndCollectForWithdrawalTx(params: {
    tx: PrismaTx;
    userId: number;
    withdrawAmount: number;
    availableBalance: number;
    frozenBalance: number;
    payOfflineFeeAmount?: number;
  }) {
    const { tx, userId, withdrawAmount, availableBalance, frozenBalance, payOfflineFeeAmount } = params;

    const bill = await this.getLastMonthOutstandingBillTx(tx, userId);

    if (!bill) {
      return { paidOfflineFeeAmount: 0, billId: null, paymentId: null };
    }

    const remaining = Number(bill.remainingAmount || 0);
    if (remaining <= 0) {
      return { paidOfflineFeeAmount: 0, billId: bill.id, paymentId: null };
    }

    // 部分缴纳最低额需受当前账单未缴余额约束，避免“剩余小于配置最低额”时无法缴清
    const effectivePartialMinPay = this.toFixed2(Math.max(0, Math.min(WITHDRAWAL_PARTIAL_MIN_PAY, remaining)));
    const requested = this.toFixed2(Number(payOfflineFeeAmount || 0));

    if (bill.enforceFullPayment && requested < remaining) {
      throw new BadRequestException(`该账单已被设置为强制全额缴纳，需至少缴纳 ${remaining}`);
    }

    if (requested <= 0) {
      throw new BadRequestException(`上月线下运营成本未缴清，需先缴纳（至少 ${effectivePartialMinPay}）`);
    }

    if (requested < effectivePartialMinPay && requested < remaining) {
      throw new BadRequestException(`部分缴纳最低金额为 ${effectivePartialMinPay}`);
    }

    const actualPay = this.toFixed2(Math.min(requested, remaining));

    if (availableBalance < withdrawAmount + actualPay) {
      throw new BadRequestException('可用余额不足，无法同时完成提现与线下费用缴纳');
    }

    const walletTotalAfterPay = this.toFixed2(availableBalance + frozenBalance - actualPay);
    const remainingAfterPay = this.toFixed2(Math.max(0, remaining - actualPay));
    if (remainingAfterPay > 0 && !(walletTotalAfterPay > remainingAfterPay)) {
      throw new BadRequestException('缴费后钱包总额度（含冻结）必须大于未缴额度');
    }

    const walletAfterFee = await (tx as any).walletAccount.update({
      where: { userId },
      data: { availableBalance: { decrement: actualPay } },
      select: { availableBalance: true, frozenBalance: true },
    });

    const payment = await (tx as any).offlineFeeBillPayment.create({
      data: {
        billId: bill.id,
        userId,
        amount: actualPay,
        source: 'WITHDRAWAL',
      },
    });

    await (tx as any).walletTransaction.create({
      data: {
        userId,
        direction: 'OUT',
        bizType: 'OFFLINE_FEE_PAYMENT',
        amount: actualPay,
        status: 'AVAILABLE',
        sourceType: 'OFFLINE_FEE_PAYMENT',
        sourceId: payment.id,
        availableAfter: this.toFixed2(Number(walletAfterFee.availableBalance || 0)),
        frozenAfter: this.toFixed2(Number(walletAfterFee.frozenBalance || 0)),
      },
    });

    await this.refreshBillPaymentStatusTx(tx, bill.id);

    return {
      paidOfflineFeeAmount: actualPay,
      billId: bill.id,
      paymentId: payment.id,
    };
  }

  async attachWithdrawalToPayment(params: { tx: PrismaTx; paymentId: number | null; withdrawalRequestId: number }) {
    if (!params.paymentId) return;

    await (params.tx as any).offlineFeeBillPayment.update({
      where: { id: params.paymentId },
      data: { withdrawalRequestId: params.withdrawalRequestId },
    });
  }
}
