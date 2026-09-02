import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DepositBizType, PenaltyFundBizType, PlayerWorkStatus, StaffEmploymentStatus, StaffLeaveStatus, UserStatus, UserType, WalletBizType, WalletDirection, WalletTxStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const INITIAL_GRACE = 72 * HOUR;
const LEAVE_END_GRACE = 16 * HOUR;

export const getActivityPenaltyAmount = (inactivityHours: number) =>
  inactivityHours >= 14 * 24 ? 20 : inactivityHours >= 7 * 24 ? 10 : 5;

export const shouldAutoExitForActivity = (available: number, deposit: number, expectedAmount: number) =>
  Math.max(0, available) + Math.max(0, deposit) <= expectedAmount;

export const isActivityAssessmentPaused = (timerPaused: boolean) => timerPaused;

export const shouldRefreshActivityAfterSettlement = (forceByAdmin: boolean) => !forceByAdmin;

@Injectable()
export class StaffActivityService {
  private readonly logger = new Logger(StaffActivityService.name);
  constructor(private readonly prisma: PrismaService) {}

  private rateFor(baseAt: Date, scheduledAt: Date) {
    const hours = Math.max(0, Math.floor((scheduledAt.getTime() - baseAt.getTime()) / HOUR));
    return { hours, amount: getActivityPenaltyAmount(hours) };
  }

  private shanghaiTomorrowRange(days: number, now = new Date()) {
    const shanghai = new Date(now.getTime() + 8 * HOUR);
    const start = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate() + 1) - 8 * HOUR);
    const end = new Date(start.getTime() + days * DAY - 1);
    return { start, end };
  }

  async createLeave(userId: number, days: number, reason?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.userType !== UserType.STAFF) throw new BadRequestException('仅服务者可以请假');
    if (user.staffEmploymentStatus !== StaffEmploymentStatus.ACTIVE) throw new BadRequestException('当前不在正常在店状态，无法请假');
    if (!user.activityAssessmentEnabled) throw new BadRequestException('当前未启用活跃度考核，无需请假');
    const { start, end } = this.shanghaiTomorrowRange(days);
    const overlap = await this.prisma.staffLeave.findFirst({
      where: { userId, status: { in: [StaffLeaveStatus.SCHEDULED, StaffLeaveStatus.ACTIVE] }, startAt: { lte: end }, endAt: { gte: start } },
    });
    if (overlap) throw new BadRequestException('已存在待生效或进行中的请假记录');
    return this.prisma.staffLeave.create({ data: { userId, days, startAt: start, endAt: end, reason: String(reason || '').trim() || null } });
  }

  async getMyOverview(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { activityAssessmentEnabled: true, activityAssessmentStartedAt: true, activityLastCompletedAt: true, activityNextChargeAt: true } });
    if (!user) throw new NotFoundException('用户不存在');
    const leave = await this.prisma.staffLeave.findFirst({ where: { userId, status: { in: [StaffLeaveStatus.SCHEDULED, StaffLeaveStatus.ACTIVE] } }, orderBy: { startAt: 'asc' } });
    return { ...user, leave, leaveEndGraceHours: 16, maxLeaveDays: 60 };
  }

  async listLeaves(input: any) {
    const page = Math.max(1, Number(input?.page || 1)); const limit = Math.min(100, Math.max(1, Number(input?.limit || 20)));
    const where: any = {};
    if (input?.userId) where.userId = Number(input.userId);
    if (input?.status) where.status = String(input.status);
    if (input?.keyword) where.user = { OR: [{ name: { contains: String(input.keyword) } }, { phone: { contains: String(input.keyword) } }] };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.staffLeave.findMany({ where, include: { user: { select: { id: true, name: true, phone: true } } }, orderBy: { id: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.staffLeave.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async listCharges(input: any) {
    const page = Math.max(1, Number(input?.page || 1)); const limit = Math.min(100, Math.max(1, Number(input?.limit || 20)));
    const where: any = {};
    if (input?.userId) where.userId = Number(input.userId);
    if (input?.keyword) where.user = { OR: [{ name: { contains: String(input.keyword) } }, { phone: { contains: String(input.keyword) } }] };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.staffActivityCharge.findMany({ where, include: { user: { select: { id: true, name: true, phone: true } } }, orderBy: { id: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.staffActivityCharge.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async getTodayStats(now = new Date()) {
    const shanghai = new Date(now.getTime() + 8 * HOUR);
    const start = new Date(Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate()) - 8 * HOUR);
    const end = new Date(start.getTime() + DAY);
    const rows = await this.prisma.staffActivityCharge.findMany({ where: { createdAt: { gte: start, lt: end } } });
    const users = new Set(rows.map(x => x.userId));
    return { userCount: users.size, chargeCount: rows.length, expectedAmount: rows.reduce((s, x) => s + Number(x.expectedAmount), 0), availableDeducted: rows.reduce((s, x) => s + Number(x.availableDeducted), 0), depositDeducted: rows.reduce((s, x) => s + Number(x.depositDeducted), 0), exitCount: rows.filter(x => x.exitTriggered).length };
  }

  async setAssessmentEnabled(userId: number, enabled: boolean) {
    const now = new Date();
    return this.prisma.user.update({ where: { id: userId }, data: { activityAssessmentEnabled: enabled, activityAssessmentStartedAt: now, activityLastCompletedAt: null, activityNextChargeAt: enabled ? new Date(now.getTime() + INITIAL_GRACE) : null, activityTimerPaused: false } });
  }

  async endLeaveOnAcceptTx(tx: any, userId: number, now = new Date()) {
    const result = await tx.staffLeave.updateMany({ where: { userId, status: { in: [StaffLeaveStatus.SCHEDULED, StaffLeaveStatus.ACTIVE] }, startAt: { lte: now }, endAt: { gte: now } }, data: { status: StaffLeaveStatus.EARLY_ENDED, actualEndAt: now } });
    if (result.count) await tx.user.update({ where: { id: userId }, data: { activityAssessmentStartedAt: now, activityLastCompletedAt: null, activityNextChargeAt: new Date(now.getTime() + LEAVE_END_GRACE) } });
  }

  async pauseOnSelfAcceptTx(tx: any, userId: number, now = new Date()) {
    await this.endLeaveOnAcceptTx(tx, userId, now);
    await tx.user.update({ where: { id: userId }, data: { activityTimerPaused: true } });
  }

  async markCompletedForUsersTx(tx: any, userIds: number[], now = new Date()) {
    if (!userIds.length) return;
    await tx.user.updateMany({ where: { id: { in: [...new Set(userIds)] }, activityAssessmentEnabled: true }, data: { activityAssessmentStartedAt: now, activityLastCompletedAt: now, activityNextChargeAt: new Date(now.getTime() + INITIAL_GRACE), activityTimerPaused: false } });
  }

  private async refreshLeaves(now: Date) {
    await this.prisma.staffLeave.updateMany({ where: { status: StaffLeaveStatus.SCHEDULED, startAt: { lte: now }, endAt: { gte: now } }, data: { status: StaffLeaveStatus.ACTIVE } });
    const ended = await this.prisma.staffLeave.findMany({ where: { status: { in: [StaffLeaveStatus.SCHEDULED, StaffLeaveStatus.ACTIVE] }, endAt: { lt: now } } });
    for (const leave of ended) {
      await this.prisma.$transaction(async tx => {
        await tx.staffLeave.update({ where: { id: leave.id }, data: { status: StaffLeaveStatus.COMPLETED, actualEndAt: leave.endAt } });
        await tx.user.updateMany({ where: { id: leave.userId, activityAssessmentEnabled: true }, data: { activityAssessmentStartedAt: leave.endAt, activityLastCompletedAt: null, activityNextChargeAt: new Date(leave.endAt.getTime() + LEAVE_END_GRACE) } });
      });
    }
  }

  private async chargeOne(userId: number, now: Date) {
    await this.prisma.$transaction(async tx => {
      await tx.$queryRawUnsafe('SELECT id FROM `User` WHERE id = ? FOR UPDATE', userId);
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user || !user.activityAssessmentEnabled || user.staffEmploymentStatus !== StaffEmploymentStatus.ACTIVE || isActivityAssessmentPaused(user.activityTimerPaused) || !user.activityNextChargeAt || user.activityNextChargeAt > now) return;
      const leave = await tx.staffLeave.findFirst({ where: { userId, status: { in: [StaffLeaveStatus.SCHEDULED, StaffLeaveStatus.ACTIVE] }, startAt: { lte: now }, endAt: { gte: now } } });
      if (leave) return;
      const scheduledAt = user.activityNextChargeAt;
      const baseAt = user.activityLastCompletedAt || user.activityAssessmentStartedAt;
      const rate = this.rateFor(baseAt, scheduledAt);
      const existing = await tx.staffActivityCharge.findUnique({ where: { userId_scheduledAt: { userId, scheduledAt } } });
      if (existing) { await tx.user.update({ where: { id: userId }, data: { activityNextChargeAt: new Date(scheduledAt.getTime() + DAY) } }); return; }
      const account = await tx.walletAccount.findUnique({ where: { userId } });
      const available = Math.max(0, Number(account?.availableBalance || 0)); const deposit = Math.max(0, Number(account?.depositBalance || 0));
      const availableDeducted = Math.min(rate.amount, available); const depositDeducted = Math.min(rate.amount - availableDeducted, deposit); const actual = availableDeducted + depositDeducted;
      const exitTriggered = shouldAutoExitForActivity(available, deposit, rate.amount);
      const charge = await tx.staffActivityCharge.create({ data: { userId, scheduledAt, inactivityHours: rate.hours, rateTier: rate.amount, expectedAmount: rate.amount, availableDeducted, depositDeducted, exitTriggered } });
      if (account && actual > 0) await tx.walletAccount.update({ where: { userId }, data: { availableBalance: { decrement: availableDeducted }, depositBalance: { decrement: depositDeducted } } });
      let walletTxId: number | null = null; let depositTxId: number | null = null;
      if (availableDeducted > 0) { const row = await tx.walletTransaction.create({ data: { userId, direction: WalletDirection.OUT, bizType: WalletBizType.STAFF_ACTIVITY_PENALTY, amount: availableDeducted, status: WalletTxStatus.AVAILABLE, sourceType: 'STAFF_ACTIVITY_CHARGE', sourceId: charge.id, availableAfter: available - availableDeducted, frozenAfter: Number(account?.frozenBalance || 0), remark: `活跃度考核扣款（${rate.amount}元档）` } }); walletTxId = row.id; }
      if (depositDeducted > 0) { const row = await tx.walletDepositTransaction.create({ data: { userId, amount: -depositDeducted, bizType: DepositBizType.ACTIVITY_PENALTY, remark: `活跃度考核扣保证金（${rate.amount}元档）` } }); depositTxId = row.id; }
      if (actual > 0) { const pool = await tx.penaltyFundPool.upsert({ where: { id: 1 }, update: {}, create: { id: 1, totalIn: 0, totalOut: 0, balance: 0 } }); await tx.penaltyFundPool.update({ where: { id: 1 }, data: { totalIn: { increment: actual }, balance: { increment: actual } } }); await tx.penaltyFundFlow.create({ data: { poolId: 1, userId, direction: 'IN', bizType: PenaltyFundBizType.ACTIVITY_DEDUCT, amount: actual, beforeBalance: pool.balance, afterBalance: Number(pool.balance) + actual, walletTxId, remark: '服务者活跃度考核扣款' } }); }
      await tx.staffActivityCharge.update({ where: { id: charge.id }, data: { walletTxId, depositTxId, exitTriggered } });
      await tx.user.update({ where: { id: userId }, data: exitTriggered ? { staffEmploymentStatus: StaffEmploymentStatus.EXITED, staffExitedAt: now, canWithdraw: false, workStatus: PlayerWorkStatus.IDLE, workOnlineExpiresAt: null, activityNextChargeAt: null, activityTimerPaused: false } : { activityNextChargeAt: new Date(scheduledAt.getTime() + DAY) } });
      if (exitTriggered) {
        await tx.staffLeave.updateMany({ where: { userId, status: { in: [StaffLeaveStatus.SCHEDULED, StaffLeaveStatus.ACTIVE] } }, data: { status: StaffLeaveStatus.CANCELED, actualEndAt: now } });
        await tx.userLog.create({ data: { userId, action: 'STAFF_ACTIVITY_AUTO_EXIT', targetType: 'USER', targetId: userId, oldData: { staffEmploymentStatus: StaffEmploymentStatus.ACTIVE } as any, newData: { staffEmploymentStatus: StaffEmploymentStatus.EXITED, availableBalance: 0, depositBalance: 0 } as any, remark: '活跃度考核扣款后可用余额及保证金耗尽，系统自动退店' } });
      }
    });
  }

  @Cron('0 */10 * * * *', { timeZone: 'Asia/Shanghai' })
  async runAssessment() {
    const now = new Date();
    try {
      await this.refreshLeaves(now);
      await this.prisma.user.updateMany({ where: { userType: UserType.STAFF, staffEmploymentStatus: StaffEmploymentStatus.ACTIVE, activityTimerPaused: false, activityAssessmentEnabled: true, activityNextChargeAt: null }, data: { activityNextChargeAt: new Date(now.getTime() + INITIAL_GRACE), activityAssessmentStartedAt: now } });
      const due = await this.prisma.user.findMany({ where: { userType: UserType.STAFF, status: UserStatus.ACTIVE, staffEmploymentStatus: StaffEmploymentStatus.ACTIVE, activityTimerPaused: false, activityAssessmentEnabled: true, activityNextChargeAt: { lte: now } }, select: { id: true }, take: 500 });
      for (const user of due) {
        try {
          await this.chargeOne(user.id, now);
        } catch (e: any) {
          this.logger.error(`staff activity charge failed user=${user.id}: ${e?.message || e}`, e?.stack);
        }
      }
    } catch (e: any) { this.logger.error(`staff activity assessment failed: ${e?.message || e}`, e?.stack); }
  }
}
