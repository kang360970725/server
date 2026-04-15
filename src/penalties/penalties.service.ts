import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  NotificationType,
  PenaltyAppealStatus,
  PenaltyFundBizType,
  PenaltyFundDirection,
  PenaltyTicketStatus,
  Prisma,
  WalletBizType,
  WalletDirection,
  WalletTxStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreatePenaltyRuleDto } from './dto/create-penalty-rule.dto';
import { UpdatePenaltyRuleDto } from './dto/update-penalty-rule.dto';
import { CreatePenaltyTicketDto } from './dto/create-penalty-ticket.dto';
import { SubmitPenaltyAppealDto } from './dto/submit-penalty-appeal.dto';
import { ReviewPenaltyAppealDto } from './dto/review-penalty-appeal.dto';
import { ConfirmPenaltyTicketDto } from './dto/confirm-penalty-ticket.dto';
import { ListPenaltyFundFlowsDto } from './dto/list-penalty-fund-flows.dto';
import { ListPenaltyRankingDto } from './dto/list-penalty-ranking.dto';

@Injectable()
export class PenaltiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // 钱包余额是 1 位小数，这里统一到 1 位，避免账户与流水金额出现尾差
  private round1(value: number) {
    return Math.round(Number(value || 0) * 10) / 10;
  }

  private normalizePaging(body: any) {
    const page = Math.max(1, Number(body?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(body?.limit || 20)));
    const skip = (page - 1) * limit;
    return { page, limit, skip };
  }

  private buildTicketNo() {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = `${now.getMonth() + 1}`.padStart(2, '0');
    const dd = `${now.getDate()}`.padStart(2, '0');
    const hh = `${now.getHours()}`.padStart(2, '0');
    const mi = `${now.getMinutes()}`.padStart(2, '0');
    const ss = `${now.getSeconds()}`.padStart(2, '0');
    const rand = `${Math.floor(Math.random() * 9000) + 1000}`;
    return `FD${yyyy}${mm}${dd}${hh}${mi}${ss}${rand}`;
  }

  private async pushPenaltyStrongReminder(input: {
    userId: number;
    ticketId: number;
    ticketNo: string;
    amount: number;
    title?: string;
    content?: string;
  }) {
    const title = input.title || `【强提醒】你有新的罚单待处理`;
    const content = input.content || `罚单号 ${input.ticketNo}，金额 ${input.amount} 元，请优先确认或申诉。`;

    // 1) 实时弱提示+强视觉弹窗（前端已接入统一实时消息流）
    await this.notificationsService.pushRealtimeToUsers({
      userIds: [input.userId],
      type: 'PENALTY_TICKET',
      title,
      content,
      route: '/staff/workbench',
      payload: {
        ticketId: input.ticketId,
        ticketNo: input.ticketNo,
        amount: input.amount,
        force: true,
      },
    });

    // 2) 同时落库到消息中心，避免用户刷新后看不到
    await this.notificationsService.batchCreateNotifications({
      userIds: [input.userId],
      type: NotificationType.SYSTEM_ANNOUNCEMENT,
      title,
      content,
      payload: {
        ticketId: input.ticketId,
        ticketNo: input.ticketNo,
        amount: input.amount,
        force: true,
      },
    });
  }

  async listRules(body: any) {
    const { page, limit, skip } = this.normalizePaging(body || {});
    const where: Prisma.PenaltyRuleWhereInput = {};

    if (body?.category) where.category = body.category;
    if (typeof body?.enabled === 'boolean') where.enabled = body.enabled;

    const keyword = String(body?.keyword || '').trim();
    if (keyword) {
      where.OR = [
        { name: { contains: keyword } },
        { code: { contains: keyword } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.penaltyRule.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ sortOrder: 'asc' }, { id: 'desc' }],
      }),
      this.prisma.penaltyRule.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async createRule(dto: CreatePenaltyRuleDto, operatorId?: number) {
    const code = String(dto.code || '').trim().toUpperCase();
    if (!code) throw new BadRequestException('条例编码不能为空');
    const name = String(dto.name || '').trim();
    if (!name) throw new BadRequestException('条例名称不能为空');

    const amount = this.round1(Number(dto.amount || 0));
    if (amount < 0) throw new BadRequestException('处罚金额不能小于0');

    return this.prisma.penaltyRule.create({
      data: {
        code,
        name,
        category: dto.category,
        amount,
        description: dto.description ? String(dto.description).trim() : null,
        enabled: dto.enabled !== false,
        sortOrder: Number(dto.sortOrder || 0),
        createdBy: Number.isFinite(operatorId as any) ? Number(operatorId) : null,
      },
    });
  }

  async updateRule(dto: UpdatePenaltyRuleDto) {
    const id = Number(dto.id);
    const exists = await this.prisma.penaltyRule.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('处罚条例不存在');

    return this.prisma.penaltyRule.update({
      where: { id },
      data: {
        name: dto.name == null ? undefined : String(dto.name).trim(),
        category: dto.category,
        amount: dto.amount == null ? undefined : this.round1(Number(dto.amount)),
        description: dto.description == null ? undefined : String(dto.description).trim(),
        enabled: typeof dto.enabled === 'boolean' ? dto.enabled : undefined,
        sortOrder: dto.sortOrder == null ? undefined : Number(dto.sortOrder),
      },
    });
  }

  async getCreateTicketContext(userId: number, ruleIds: number[]) {
    const staffId = Number(userId);
    const uniqRuleIds = Array.from(new Set((ruleIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)));
    if (!uniqRuleIds.length) throw new BadRequestException('至少选择一条处罚条例');

    const rules = await this.prisma.penaltyRule.findMany({
      where: { id: { in: uniqRuleIds }, enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    if (rules.length !== uniqRuleIds.length) {
      throw new BadRequestException('存在不可用或已禁用的处罚条例');
    }

    const categories = Array.from(new Set(rules.map((x) => x.category)));
    const grouped = await this.prisma.penaltyTicketDetail.groupBy({
      by: ['ruleCategorySnapshot'],
      where: {
        ruleCategorySnapshot: { in: categories },
        ticket: {
          userId: staffId,
          status: { in: [PenaltyTicketStatus.PENDING_CONFIRM, PenaltyTicketStatus.APPEAL_PENDING, PenaltyTicketStatus.EFFECTIVE] },
        },
      },
      _count: { _all: true },
    });

    const sameCategoryStats: Record<string, number> = {};
    for (const category of categories) {
      const row = grouped.find((x) => x.ruleCategorySnapshot === category);
      sameCategoryStats[category] = Number(row?._count?._all || 0);
    }

    const ruleAmount = this.round1(
      rules.reduce((sum, item) => sum + Number(item.amount || 0), 0),
    );

    return { rules, categories, ruleAmount, sameCategoryStats };
  }

  async createTicket(dto: CreatePenaltyTicketDto, operatorId?: number) {
    const userId = Number(dto.userId);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, phone: true, status: true } });
    if (!user) throw new NotFoundException('陪玩不存在');

    const context = await this.getCreateTicketContext(userId, dto.ruleIds || []);
    const finalAmount = dto.finalAmount == null
      ? context.ruleAmount
      : this.round1(Number(dto.finalAmount));

    if (finalAmount < 0) throw new BadRequestException('罚单总额不能小于0');

    const created = await this.prisma.penaltyTicket.create({
      data: {
        ticketNo: this.buildTicketNo(),
        userId,
        creatorId: Number.isFinite(operatorId as any) ? Number(operatorId) : null,
        status: PenaltyTicketStatus.PENDING_CONFIRM,
        appealStatus: PenaltyAppealStatus.NONE,
        ruleAmount: context.ruleAmount,
        finalAmount,
        reason: dto.reason ? String(dto.reason).trim() : null,
        sameCategoryStats: context.sameCategoryStats as any,
        details: {
          create: context.rules.map((rule) => ({
            ruleId: rule.id,
            ruleCodeSnapshot: rule.code,
            ruleNameSnapshot: rule.name,
            ruleCategorySnapshot: rule.category,
            amount: this.round1(Number(rule.amount || 0)),
            descriptionSnapshot: rule.description || null,
          })),
        },
      },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        details: true,
      },
    });

    // 新罚单创建后立即强提醒陪玩优先处理
    await this.pushPenaltyStrongReminder({
      userId,
      ticketId: created.id,
      ticketNo: created.ticketNo,
      amount: Number(created.finalAmount),
    });

    return created;
  }

  async listTickets(body: any) {
    const { page, limit, skip } = this.normalizePaging(body || {});
    const where: Prisma.PenaltyTicketWhereInput = {};

    if (body?.userId) where.userId = Number(body.userId);
    if (body?.status) where.status = body.status;
    if (body?.appealStatus) where.appealStatus = body.appealStatus;

    const keyword = String(body?.keyword || '').trim();
    if (keyword) {
      where.OR = [
        { ticketNo: { contains: keyword } },
        { reason: { contains: keyword } },
        { user: { name: { contains: keyword } } },
        { user: { phone: { contains: keyword } } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.penaltyTicket.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ id: 'desc' }],
        include: {
          user: { select: { id: true, name: true, phone: true } },
          creator: { select: { id: true, name: true } },
          appealReviewer: { select: { id: true, name: true } },
          details: true,
          appeals: true,
        },
      }),
      this.prisma.penaltyTicket.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async listMyTickets(userId: number, body: any) {
    return this.listTickets({ ...(body || {}), userId });
  }

  private async applyPenaltyDeductionTx(tx: Prisma.TransactionClient, input: {
    ticketId: number;
    userId: number;
    amount: number;
    operatorId?: number | null;
  }) {
    const amount = this.round1(Number(input.amount || 0));
    if (amount <= 0) {
      return { deductedAmount: 0, walletTxId: null };
    }

    await this.walletService.ensureWalletAccount(input.userId, tx as any);

    const account = await tx.walletAccount.findUnique({
      where: { userId: input.userId },
      select: { availableBalance: true, frozenBalance: true },
    });
    if (!account) throw new BadRequestException('钱包账户不存在');

    const beforeAvailable = Number(account.availableBalance || 0);
    const beforeFrozen = Number(account.frozenBalance || 0);
    if (beforeAvailable < amount) {
      throw new BadRequestException(`钱包余额不足，当前可用余额 ${beforeAvailable}，罚单金额 ${amount}`);
    }

    const afterAvailable = this.round1(beforeAvailable - amount);

    await tx.walletAccount.update({
      where: { userId: input.userId },
      data: {
        availableBalance: { decrement: amount },
      },
    });

    // sourceType + sourceId 作为幂等键，保证同一罚单不会重复扣款
    const walletTx = await tx.walletTransaction.create({
      data: {
        userId: input.userId,
        direction: WalletDirection.OUT,
        bizType: WalletBizType.DEPOSIT_DEDUCT,
        amount,
        status: WalletTxStatus.AVAILABLE,
        sourceType: 'PENALTY_TICKET',
        sourceId: input.ticketId,
        availableAfter: afterAvailable,
        frozenAfter: beforeFrozen,
      },
      select: { id: true },
    });

    const pool = await tx.penaltyFundPool.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        totalIn: 0,
        totalOut: 0,
        balance: 0,
      },
      select: { id: true, balance: true },
    });

    const beforeBalance = Number(pool.balance || 0);
    const afterBalance = this.round1(beforeBalance + amount);

    await tx.penaltyFundPool.update({
      where: { id: pool.id },
      data: {
        totalIn: { increment: amount },
        balance: { increment: amount },
      },
    });

    await tx.penaltyFundFlow.create({
      data: {
        poolId: pool.id,
        ticketId: input.ticketId,
        userId: input.userId,
        direction: PenaltyFundDirection.IN,
        bizType: PenaltyFundBizType.PENALTY_DEDUCT,
        amount,
        beforeBalance,
        afterBalance,
        walletTxId: walletTx.id,
        operatorId: Number.isFinite(input.operatorId as any) ? Number(input.operatorId) : null,
      },
    });

    return { deductedAmount: amount, walletTxId: walletTx.id };
  }

  async confirmMyTicket(userId: number, dto: ConfirmPenaltyTicketDto) {
    const ticketId = Number(dto.ticketId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.penaltyTicket.findUnique({ where: { id: ticketId } });
      if (!ticket || ticket.userId !== Number(userId)) throw new NotFoundException('罚单不存在');
      if (ticket.status !== PenaltyTicketStatus.PENDING_CONFIRM) {
        throw new BadRequestException('当前罚单状态不允许确认');
      }

      const deductRes = await this.applyPenaltyDeductionTx(tx, {
        ticketId,
        userId: Number(userId),
        amount: Number(ticket.finalAmount),
        operatorId: Number(userId),
      });

      return tx.penaltyTicket.update({
        where: { id: ticketId },
        data: {
          status: PenaltyTicketStatus.EFFECTIVE,
          deductedAmount: deductRes.deductedAmount,
          deductWalletTxId: deductRes.walletTxId,
          deductedAt: new Date(),
          confirmAt: new Date(),
        },
      });
    });

    return updated;
  }

  async submitMyAppeal(userId: number, dto: SubmitPenaltyAppealDto) {
    const ticketId = Number(dto.ticketId);
    const content = String(dto.content || '').trim();
    if (!content) throw new BadRequestException('申诉说明不能为空');

    const updated = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.penaltyTicket.findUnique({
        where: { id: ticketId },
        include: { appeals: true },
      });
      if (!ticket || ticket.userId !== Number(userId)) throw new NotFoundException('罚单不存在');
      if (ticket.status !== PenaltyTicketStatus.PENDING_CONFIRM) {
        throw new BadRequestException('当前罚单状态不允许发起申诉');
      }
      if ((ticket.appeals || []).length > 0 || ticket.appealStatus !== PenaltyAppealStatus.NONE) {
        throw new BadRequestException('该罚单已发起过申诉，不能重复申诉');
      }

      await tx.penaltyAppeal.create({
        data: {
          ticketId,
          userId: Number(userId),
          content,
          status: PenaltyAppealStatus.PENDING,
        },
      });

      return tx.penaltyTicket.update({
        where: { id: ticketId },
        data: {
          status: PenaltyTicketStatus.APPEAL_PENDING,
          appealStatus: PenaltyAppealStatus.PENDING,
        },
      });
    });

    return updated;
  }

  async reviewAppeal(dto: ReviewPenaltyAppealDto, reviewerId?: number) {
    const ticketId = Number(dto.ticketId);
    let notifyPayload: {
      userId: number;
      ticketId: number;
      ticketNo: string;
      amount: number;
      title: string;
      content: string;
    } | null = null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const ticket = await tx.penaltyTicket.findUnique({
        where: { id: ticketId },
        include: { appeals: true },
      });
      if (!ticket) throw new NotFoundException('罚单不存在');
      if (ticket.status !== PenaltyTicketStatus.APPEAL_PENDING) {
        throw new BadRequestException('当前罚单不在申诉审核状态');
      }

      const appeal = (ticket.appeals || [])[0];
      if (!appeal || appeal.status !== PenaltyAppealStatus.PENDING) {
        throw new BadRequestException('未找到待审核申诉记录');
      }

      const now = new Date();

      if (dto.approved) {
        await tx.penaltyAppeal.update({
          where: { id: appeal.id },
          data: {
            status: PenaltyAppealStatus.APPROVED,
            reviewedBy: Number.isFinite(reviewerId as any) ? Number(reviewerId) : null,
            reviewedAt: now,
            reviewRemark: dto.reviewRemark ? String(dto.reviewRemark).trim() : null,
          },
        });

        const result = await tx.penaltyTicket.update({
          where: { id: ticketId },
          data: {
            status: PenaltyTicketStatus.INVALID,
            appealStatus: PenaltyAppealStatus.APPROVED,
            appealReviewerId: Number.isFinite(reviewerId as any) ? Number(reviewerId) : null,
          },
        });

        notifyPayload = {
          userId: ticket.userId,
          ticketId: ticket.id,
          ticketNo: ticket.ticketNo,
          amount: Number(ticket.finalAmount),
          title: `罚单申诉已通过`,
          content: `罚单号 ${ticket.ticketNo} 申诉已通过，本次罚单已失效。`,
        };

        return result;
      }

      // 审核驳回：罚单继续生效并立即扣款
      await tx.penaltyAppeal.update({
        where: { id: appeal.id },
        data: {
          status: PenaltyAppealStatus.REJECTED,
          reviewedBy: Number.isFinite(reviewerId as any) ? Number(reviewerId) : null,
          reviewedAt: now,
          reviewRemark: dto.reviewRemark ? String(dto.reviewRemark).trim() : null,
        },
      });

      const deductRes = await this.applyPenaltyDeductionTx(tx, {
        ticketId,
        userId: ticket.userId,
        amount: Number(ticket.finalAmount),
        operatorId: Number.isFinite(reviewerId as any) ? Number(reviewerId) : null,
      });

      const result = await tx.penaltyTicket.update({
        where: { id: ticketId },
        data: {
          status: PenaltyTicketStatus.EFFECTIVE,
          appealStatus: PenaltyAppealStatus.REJECTED,
          appealReviewerId: Number.isFinite(reviewerId as any) ? Number(reviewerId) : null,
          deductedAmount: deductRes.deductedAmount,
          deductWalletTxId: deductRes.walletTxId,
          deductedAt: now,
        },
      });

      notifyPayload = {
        userId: ticket.userId,
        ticketId: ticket.id,
        ticketNo: ticket.ticketNo,
        amount: Number(ticket.finalAmount),
        title: `罚单申诉未通过`,
        content: `罚单号 ${ticket.ticketNo} 申诉未通过，已按规则扣款 ${deductRes.deductedAmount} 元。`,
      };

      return result;
    });

    if (notifyPayload) {
      await this.pushPenaltyStrongReminder(notifyPayload);
    }

    return updated;
  }

  async getFundStats() {
    const [pool, ticketStats] = await Promise.all([
      this.prisma.penaltyFundPool.findUnique({ where: { id: 1 } }),
      this.prisma.penaltyTicket.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    const statusCountMap: Record<string, number> = {};
    for (const row of ticketStats) statusCountMap[row.status] = Number(row._count?._all || 0);

    return {
      pool: pool || {
        id: 1,
        totalIn: 0,
        totalOut: 0,
        balance: 0,
      },
      statusCountMap,
    };
  }

  async listFundFlows(dto: ListPenaltyFundFlowsDto) {
    const { page, limit, skip } = this.normalizePaging(dto || {});
    const where: Prisma.PenaltyFundFlowWhereInput = {};

    if (dto.direction) where.direction = dto.direction;
    if (dto.bizType) where.bizType = dto.bizType;

    const [data, total] = await Promise.all([
      this.prisma.penaltyFundFlow.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ id: 'desc' }],
        include: {
          user: { select: { id: true, name: true, phone: true } },
          ticket: { select: { id: true, ticketNo: true, finalAmount: true } },
        },
      }),
      this.prisma.penaltyFundFlow.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async listPenaltyRanking(dto: ListPenaltyRankingDto) {
    const top = Math.min(100, Math.max(1, Number(dto?.top || 20)));

    const grouped = await this.prisma.penaltyTicket.groupBy({
      by: ['userId'],
      where: { status: PenaltyTicketStatus.EFFECTIVE },
      _sum: { deductedAmount: true },
      _count: { _all: true },
      orderBy: { _sum: { deductedAmount: 'desc' } },
      take: top,
    });

    const userIds = grouped.map((x) => Number(x.userId));
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, phone: true },
        })
      : [];

    const userMap = new Map(users.map((u) => [Number(u.id), u]));
    const list = grouped.map((row, idx) => ({
      rank: idx + 1,
      userId: Number(row.userId),
      user: userMap.get(Number(row.userId)) || null,
      penaltyCount: Number(row._count?._all || 0),
      totalDeductedAmount: Number(row._sum?.deductedAmount || 0),
    }));

    return { list, top };
  }
}
