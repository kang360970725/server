import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { QueryOfflineFeeBillsDto } from './dto/query-offline-fee-bills.dto';
import { ManualCreateOfflineFeeBillDto } from './dto/manual-create-offline-fee-bill.dto';
import { UpdateOfflineFeeBillDto } from './dto/update-offline-fee-bill.dto';

const BEIJING_TZ = 'Asia/Shanghai';

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

  async generateBillsForMonth(month: string) {
    return this.prisma.$transaction(async (tx) => this.generateBillsForMonthTx(tx as any, month));
  }

  private async generateBillsForMonthTx(db: PrismaTx, month: string) {
    const { start, end } = this.getMonthRange(month);
    const cfg = await this.getFeeConfig(db);

    const offlineUsers = await (db as any).user.findMany({
      where: {
        userType: 'STAFF',
        workMode: 'OFFLINE',
        OR: [{ offlineJoinedAt: null }, { offlineJoinedAt: { lte: end } }],
      },
      select: { id: true, offlineJoinedAt: true },
    });

    let affected = 0;

    for (const user of offlineUsers) {
      const perfAgg = await (db as any).performanceRecord.aggregate({
        where: {
          ownerUserId: user.id,
          ownerRoleType: 'PLAYER',
          status: 'EFFECTIVE',
          statsDate: { gte: start, lte: end },
        },
        _sum: { grossPerformanceAmount: true },
      });

      const gross = Number(perfAgg?._sum?.grossPerformanceAmount || 0);
      const ratio = this.calcJoinedRatio(user.offlineJoinedAt, start, end);
      const baseAmount = this.toFixed2(gross * ratio);
      const shouldPay = this.calcShouldPay(baseAmount, cfg.rate, cfg.minAmount, cfg.capAmount);

      const existing = await (db as any).offlineFeeBill.findUnique({
        where: { userId_billMonth: { userId: user.id, billMonth: month } },
        select: { id: true, paidAmount: true, enforceFullPayment: true, lastRemindAt: true },
      });

      const paid = Number(existing?.paidAmount || 0);
      const remaining = this.toFixed2(Math.max(0, shouldPay - paid));
      const status = remaining <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';

      await (db as any).offlineFeeBill.upsert({
        where: { userId_billMonth: { userId: user.id, billMonth: month } },
        update: {
          periodStart: start,
          periodEnd: end,
          performanceBaseAmount: baseAmount,
          rate: cfg.rate,
          minAmount: cfg.minAmount,
          capAmount: cfg.capAmount,
          shouldPayAmount: shouldPay,
          remainingAmount: remaining,
          status,
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
          shouldPayAmount: shouldPay,
          paidAmount: 0,
          remainingAmount: shouldPay,
          status: shouldPay > 0 ? 'UNPAID' : 'PAID',
          generatedAt: new Date(),
        },
      });

      affected += 1;
    }

    return { month, affected };
  }

  @Cron('0 5 1 * * *', { timeZone: BEIJING_TZ })
  async cronGenerateLastMonthBills() {
    const now = new Date();
    if (now.getDate() !== 5) return;

    const month = this.getPreviousMonth(now);
    await this.generateBillsForMonth(month);
  }

  async listBills(query: QueryOfflineFeeBillsDto) {
    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
    const where: any = {};

    if (query.billMonth) where.billMonth = query.billMonth;
    if (query.status) where.status = query.status;
    if (query.userId) where.userId = Number(query.userId);
    if (query.onlyOutstanding) where.remainingAmount = { gt: 0 };

    const [list, total] = await this.prisma.$transaction([
      this.prisma.offlineFeeBill.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ billMonth: 'desc' }, { id: 'desc' }],
        include: {
          user: {
            select: { id: true, name: true, phone: true, workMode: true, offlineJoinedAt: true },
          },
        },
      }),
      this.prisma.offlineFeeBill.count({ where }),
    ]);

    return { list, total, page, limit };
  }

  async listOfflineStaffOptions(keyword?: string) {
    const where: any = {
      userType: 'STAFF',
      workMode: 'OFFLINE',
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

  async manualCreateBill(dto: ManualCreateOfflineFeeBillDto) {
    const userId = Number(dto.userId);
    const month = String(dto.month || '').trim();
    const performanceBaseAmount = this.toFixed2(Math.max(0, Number(dto.performanceBaseAmount || 0)));
    const { start, end } = this.getMonthRange(month);

    return this.prisma.$transaction(async (tx) => {
      const user = await (tx as any).user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          userType: true,
          workMode: true,
          offlineJoinedAt: true,
        },
      });

      if (!user) throw new NotFoundException('员工不存在');
      if (user.userType !== 'STAFF' || user.workMode !== 'OFFLINE') {
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

      const cfg = await this.getFeeConfig(tx as any);
      const shouldPay = this.calcShouldPay(performanceBaseAmount, cfg.rate, cfg.minAmount, cfg.capAmount);

      const existing = await (tx as any).offlineFeeBill.findUnique({
        where: { userId_billMonth: { userId, billMonth: month } },
        select: { id: true, paidAmount: true },
      });

      const paid = Number(existing?.paidAmount || 0);
      const remaining = this.toFixed2(Math.max(0, shouldPay - paid));
      const status = remaining <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';

      const bill = await (tx as any).offlineFeeBill.upsert({
        where: { userId_billMonth: { userId, billMonth: month } },
        update: {
          periodStart: start,
          periodEnd: end,
          performanceBaseAmount,
          rate: cfg.rate,
          minAmount: cfg.minAmount,
          capAmount: cfg.capAmount,
          shouldPayAmount: shouldPay,
          remainingAmount: remaining,
          status,
          generatedAt: new Date(),
        },
        create: {
          userId,
          billMonth: month,
          periodStart: start,
          periodEnd: end,
          performanceBaseAmount,
          rate: cfg.rate,
          minAmount: cfg.minAmount,
          capAmount: cfg.capAmount,
          shouldPayAmount: shouldPay,
          paidAmount: 0,
          remainingAmount: shouldPay,
          status: shouldPay > 0 ? 'UNPAID' : 'PAID',
          generatedAt: new Date(),
        },
      });

      return bill;
    });
  }

  async setEnforceFullPayment(billId: number, enforceFullPayment: boolean) {
    const bill = await this.prisma.offlineFeeBill.findUnique({ where: { id: billId } });
    if (!bill) throw new NotFoundException('线下费用账单不存在');

    return this.prisma.offlineFeeBill.update({
      where: { id: billId },
      data: { enforceFullPayment },
    });
  }

  async remindBill(billId: number) {
    const bill = await this.prisma.offlineFeeBill.findUnique({ where: { id: billId } });
    if (!bill) throw new NotFoundException('线下费用账单不存在');

    return this.prisma.offlineFeeBill.update({
      where: { id: billId },
      data: { lastRemindAt: new Date() },
    });
  }

  async updateBill(dto: UpdateOfflineFeeBillDto) {
    const billId = Number(dto.billId);
    const performanceBaseAmount = this.toFixed2(Math.max(0, Number(dto.performanceBaseAmount || 0)));

    return this.prisma.$transaction(async (tx) => {
      const bill = await (tx as any).offlineFeeBill.findUnique({ where: { id: billId } });
      if (!bill) throw new NotFoundException('线下费用账单不存在');

      // 账单编辑沿用账单生成时固化的费率与上下限，确保历史口径一致
      const shouldPay = this.calcShouldPay(
        performanceBaseAmount,
        Number(bill.rate || 0),
        Number(bill.minAmount || 0),
        Number(bill.capAmount || 0),
      );

      const paid = this.toFixed2(Number(bill.paidAmount || 0));
      const remaining = this.toFixed2(Math.max(0, shouldPay - paid));
      const status = remaining <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';

      return (tx as any).offlineFeeBill.update({
        where: { id: billId },
        data: {
          performanceBaseAmount,
          shouldPayAmount: shouldPay,
          remainingAmount: remaining,
          status,
        },
      });
    });
  }

  private async getLastMonthOutstandingBillTx(db: PrismaTx, userId: number, now = new Date()) {
    const billMonth = this.getPreviousMonth(now);
    await this.generateBillsForMonthTx(db, billMonth);

    return (db as any).offlineFeeBill.findUnique({
      where: { userId_billMonth: { userId, billMonth } },
    });
  }

  async getWithdrawalGuardInfo(userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const bill = await this.getLastMonthOutstandingBillTx(tx as any, userId);
      const cfg = await this.getFeeConfig(tx as any);
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
          partialMinPay: cfg.partialMinPay,
          bill: null,
          availableBalance,
          frozenBalance,
          walletTotal,
          canPartialPayByWalletRule: true,
        };
      }

      const remaining = Number(bill.remainingAmount || 0);
      const effectivePartialMinPay = this.toFixed2(Math.max(0, Math.min(cfg.partialMinPay, remaining)));
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

      return this.refreshBillPaymentStatusTx(tx as any, bill.id);
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
    const cfg = await this.getFeeConfig(tx);

    if (!bill) {
      return { paidOfflineFeeAmount: 0, billId: null, paymentId: null };
    }

    const remaining = Number(bill.remainingAmount || 0);
    if (remaining <= 0) {
      return { paidOfflineFeeAmount: 0, billId: bill.id, paymentId: null };
    }

    // 部分缴纳最低额需受当前账单未缴余额约束，避免“剩余小于配置最低额”时无法缴清
    const effectivePartialMinPay = this.toFixed2(Math.max(0, Math.min(cfg.partialMinPay, remaining)));
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
