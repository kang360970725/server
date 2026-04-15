import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  NotificationType,
  PenaltyAppealStatus,
  PenaltyFundBizType,
  PenaltyFundDirection,
  PenaltyRuleCategory,
  PenaltyTicketStatus,
  Prisma,
  WalletBizType,
  WalletDirection,
  WalletTxStatus,
  UserType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UserLogsService } from '../user-logs/user-logs.service';
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
  // 进程内催办冷却（30分钟），避免同一罚单频繁强提醒造成骚扰
  private readonly remindCooldownMs = 30 * 60 * 1000;
  private readonly remindCooldownMap = new Map<number, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly notificationsService: NotificationsService,
    private readonly userLogsService: UserLogsService,
  ) {}

  // 钱包余额是 1 位小数，这里统一到 1 位，避免账户与流水金额出现尾差
  private round1(value: number) {
    return Math.round(Number(value || 0) * 10) / 10;
  }

  // 枚举中文化：前端可以直接展示，避免出现原始 ENUM 常量
  private readonly categoryLabelMap: Record<PenaltyRuleCategory, string> = {
    SERVICE: '服务类违规',
    ATTENDANCE: '出勤类违规',
    DISCIPLINE: '纪律类违规',
    SAFETY: '安全类违规',
    OTHER: '其他违规',
  };

  private readonly ticketStatusLabelMap: Record<PenaltyTicketStatus, string> = {
    PENDING_CONFIRM: '待确认/申诉',
    APPEAL_PENDING: '申诉审核中',
    EFFECTIVE: '已生效',
    INVALID: '已失效',
  };

  private readonly appealStatusLabelMap: Record<PenaltyAppealStatus, string> = {
    NONE: '未申诉',
    PENDING: '申诉待审核',
    APPROVED: '申诉通过',
    REJECTED: '申诉驳回',
  };

  private readonly fundBizTypeLabelMap: Record<PenaltyFundBizType, string> = {
    PENALTY_DEDUCT: '罚单扣款入池',
    APPEAL_REFUND: '申诉退款出池',
    MANUAL_ADJUST: '人工调整',
  };

  private enrichRuleLabel<T extends { category: PenaltyRuleCategory }>(row: T) {
    return {
      ...row,
      categoryLabel: this.categoryLabelMap[row.category] || row.category,
    };
  }

  private enrichTicketLabel<
    T extends { status: PenaltyTicketStatus; appealStatus: PenaltyAppealStatus; details?: any[]; sameCategoryStats?: any }
  >(row: T) {
    return {
      ...row,
      statusLabel: this.ticketStatusLabelMap[row.status] || row.status,
      appealStatusLabel: this.appealStatusLabelMap[row.appealStatus] || row.appealStatus,
      details: Array.isArray(row.details)
        ? row.details.map((x) => ({
            ...x,
            ruleCategoryLabel: this.categoryLabelMap[x.ruleCategorySnapshot] || x.ruleCategorySnapshot,
          }))
        : row.details,
      sameCategoryStatsLabel: row.sameCategoryStats
        ? Object.fromEntries(
            Object.keys(row.sameCategoryStats).map((key) => [
              this.categoryLabelMap[key as PenaltyRuleCategory] || key,
              (row.sameCategoryStats as any)[key],
            ]),
          )
        : undefined,
    };
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

  private async pushAppealReviewReminderToAdmins(input: {
    ticketId: number;
    ticketNo: string;
    userId: number;
  }) {
    const admins = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        userType: {
          in: [UserType.SUPER_ADMIN, UserType.ADMIN, UserType.OPERATION],
        },
      },
      select: { id: true },
    });
    const adminIds = admins.map((x) => Number(x.id));
    if (!adminIds.length) return;

    const title = `【待审核】罚单申诉待处理`;
    const content = `罚单号 ${input.ticketNo} 已发起申诉，请尽快审核。`;
    const payload = {
      ticketId: input.ticketId,
      ticketNo: input.ticketNo,
      userId: input.userId,
      routeType: 'PENALTY_APPEAL_REVIEW',
      force: true,
    };

    await this.notificationsService.pushRealtimeToUsers({
      userIds: adminIds,
      type: 'PENALTY_APPEAL_REVIEW',
      title,
      content,
      route: '/penalties',
      payload,
    });

    await this.notificationsService.batchCreateNotifications({
      userIds: adminIds,
      type: NotificationType.SYSTEM_ANNOUNCEMENT,
      title,
      content,
      payload,
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

    return {
      data: data.map((x) => this.enrichRuleLabel(x)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      dict: {
        categoryLabelMap: this.categoryLabelMap,
      },
    };
  }

  async listEnabledRulesForSelect() {
    const data = await this.prisma.penaltyRule.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        category: true,
        amount: true,
        description: true,
      },
    });
    return {
      data: data.map((x) => this.enrichRuleLabel(x)),
      dict: {
        categoryLabelMap: this.categoryLabelMap,
      },
    };
  }

  async getDict() {
    return {
      categoryLabelMap: this.categoryLabelMap,
      ticketStatusLabelMap: this.ticketStatusLabelMap,
      appealStatusLabelMap: this.appealStatusLabelMap,
      fundBizTypeLabelMap: this.fundBizTypeLabelMap,
    };
  }

  async createRule(dto: CreatePenaltyRuleDto, operatorId?: number) {
    const code = String(dto.code || '').trim().toUpperCase();
    if (!code) throw new BadRequestException('条例编码不能为空');
    const name = String(dto.name || '').trim();
    if (!name) throw new BadRequestException('条例名称不能为空');

    const amount = this.round1(Number(dto.amount || 0));
    if (amount < 0) throw new BadRequestException('处罚金额不能小于0');

    const created = await this.prisma.penaltyRule.create({
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

    if (operatorId) {
      await this.userLogsService.writeLog({
        userId: Number(operatorId),
        action: 'PENALTY_RULE_CREATE',
        targetType: 'PENALTY_RULE',
        targetId: created.id,
        newData: created as any,
        remark: `创建处罚条例：${created.name}(${created.code})`,
      });
    }

    return created;
  }

  async updateRule(dto: UpdatePenaltyRuleDto, operatorId?: number) {
    const id = Number(dto.id);
    const exists = await this.prisma.penaltyRule.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('处罚条例不存在');

    const updated = await this.prisma.penaltyRule.update({
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

    if (operatorId) {
      await this.userLogsService.writeLog({
        userId: Number(operatorId),
        action: 'PENALTY_RULE_UPDATE',
        targetType: 'PENALTY_RULE',
        targetId: updated.id,
        oldData: exists as any,
        newData: updated as any,
        remark: `更新处罚条例：${updated.name}(${updated.code})`,
      });
    }

    return updated;
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

    return {
      rules: rules.map((x) => this.enrichRuleLabel(x)),
      categories,
      categoryLabels: categories.map((x) => ({
        key: x,
        label: this.categoryLabelMap[x] || x,
      })),
      ruleAmount,
      sameCategoryStats,
      sameCategoryStatsLabel: Object.fromEntries(
        categories.map((x) => [this.categoryLabelMap[x] || x, sameCategoryStats[x] || 0]),
      ),
    };
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

    if (operatorId) {
      await this.userLogsService.writeLog({
        userId: Number(operatorId),
        action: 'PENALTY_TICKET_CREATE',
        targetType: 'PENALTY_TICKET',
        targetId: created.id,
        newData: {
          userId: created.userId,
          ticketNo: created.ticketNo,
          ruleAmount: created.ruleAmount,
          finalAmount: created.finalAmount,
          detailIds: created.details?.map((x) => x.id) || [],
        } as any,
        remark: `开具罚单：${created.ticketNo}`,
      });
    }

    return this.enrichTicketLabel(created as any);
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

    return {
      data: data.map((x) => this.enrichTicketLabel(x as any)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      dict: {
        ticketStatusLabelMap: this.ticketStatusLabelMap,
        appealStatusLabelMap: this.appealStatusLabelMap,
        categoryLabelMap: this.categoryLabelMap,
      },
    };
  }

  async listMyTickets(userId: number, body: any) {
    return this.listTickets({ ...(body || {}), userId });
  }

  async getTicketDetail(ticketId: number, userId?: number) {
    const id = Number(ticketId);
    if (!id) throw new BadRequestException('ticketId不能为空');

    const row = await this.prisma.penaltyTicket.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, phone: true } },
        creator: { select: { id: true, name: true } },
        appealReviewer: { select: { id: true, name: true } },
        details: true,
        appeals: true,
      },
    });
    if (!row) throw new NotFoundException('罚单不存在');
    if (userId && Number(row.userId) !== Number(userId)) {
      throw new BadRequestException('无权查看该罚单');
    }
    return this.enrichTicketLabel(row as any);
  }

  async getMyPendingStats(userId: number) {
    const uid = Number(userId);
    const [pendingConfirmCount, appealPendingCount] = await Promise.all([
      this.prisma.penaltyTicket.count({
        where: {
          userId: uid,
          status: PenaltyTicketStatus.PENDING_CONFIRM,
        },
      }),
      this.prisma.penaltyTicket.count({
        where: {
          userId: uid,
          status: PenaltyTicketStatus.APPEAL_PENDING,
        },
      }),
    ]);

    return {
      pendingConfirmCount,
      appealPendingCount,
      forcePendingCount: pendingConfirmCount + appealPendingCount,
    };
  }

  private async applyPenaltyDeductionTx(tx: Prisma.TransactionClient, input: {
    ticketId: number;
    userId: number;
    amount: number;
    operatorId?: number | null;
  }) {
    const ticketId = Number(input.ticketId);
    const userId = Number(input.userId);
    const amount = this.round1(Number(input.amount || 0));
    if (amount <= 0) {
      return { deductedAmount: 0, walletTxId: null };
    }

    // 幂等兜底：
    // 如果同一罚单资金流已存在，说明扣款链路已经执行过，直接返回，避免重复扣减余额。
    const existingFlow = await tx.penaltyFundFlow.findFirst({
      where: {
        ticketId,
        bizType: PenaltyFundBizType.PENALTY_DEDUCT,
      },
      orderBy: { id: 'desc' },
      select: {
        amount: true,
        walletTxId: true,
      },
    });
    if (existingFlow) {
      return {
        deductedAmount: Number(existingFlow.amount || 0),
        walletTxId: existingFlow.walletTxId || null,
      };
    }

    await this.walletService.ensureWalletAccount(userId, tx as any);

    const account = await tx.walletAccount.findUnique({
      where: { userId },
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
      where: { userId },
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
        sourceId: ticketId,
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
        ticketId,
        userId,
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

    await this.userLogsService.writeLog({
      userId: Number(userId),
      action: 'PENALTY_TICKET_CONFIRM',
      targetType: 'PENALTY_TICKET',
      targetId: updated.id,
      newData: {
        status: updated.status,
        deductedAmount: updated.deductedAmount,
        deductWalletTxId: updated.deductWalletTxId,
      } as any,
      remark: `确认罚单并扣款：${updated.ticketNo}`,
    });

    return this.enrichTicketLabel(updated as any);
  }

  async submitMyAppeal(userId: number, dto: SubmitPenaltyAppealDto) {
    const ticketId = Number(dto.ticketId);
    const content = String(dto.content || '').trim();
    if (!content) throw new BadRequestException('申诉说明不能为空');

    let notifyReviewPayload: { ticketId: number; ticketNo: string; userId: number } | null = null;
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

      const updatedTicket = await tx.penaltyTicket.update({
        where: { id: ticketId },
        data: {
          status: PenaltyTicketStatus.APPEAL_PENDING,
          appealStatus: PenaltyAppealStatus.PENDING,
        },
      });
      notifyReviewPayload = {
        ticketId: updatedTicket.id,
        ticketNo: ticket.ticketNo,
        userId: ticket.userId,
      };
      return updatedTicket;
    });

    if (notifyReviewPayload) {
      await this.pushAppealReviewReminderToAdmins(notifyReviewPayload);
    }

    await this.userLogsService.writeLog({
      userId: Number(userId),
      action: 'PENALTY_APPEAL_SUBMIT',
      targetType: 'PENALTY_TICKET',
      targetId: updated.id,
      newData: {
        status: updated.status,
        appealStatus: updated.appealStatus,
      } as any,
      remark: `发起罚单申诉：${ticketId}`,
    });

    return this.enrichTicketLabel(updated as any);
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

    if (reviewerId) {
      await this.userLogsService.writeLog({
        userId: Number(reviewerId),
        action: dto.approved ? 'PENALTY_APPEAL_APPROVE' : 'PENALTY_APPEAL_REJECT',
        targetType: 'PENALTY_TICKET',
        targetId: updated.id,
        newData: {
          status: updated.status,
          appealStatus: updated.appealStatus,
          deductedAmount: updated.deductedAmount,
          deductWalletTxId: updated.deductWalletTxId,
        } as any,
        remark: `审核罚单申诉：${ticketId}`,
      });
    }

    return this.enrichTicketLabel(updated as any);
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

  async listAppeals(body: any) {
    const { page, limit, skip } = this.normalizePaging(body || {});
    const where: Prisma.PenaltyAppealWhereInput = {};
    if (body?.status) where.status = body.status;
    if (body?.userId) where.userId = Number(body.userId);
    if (body?.ticketId) where.ticketId = Number(body.ticketId);

    const keyword = String(body?.keyword || '').trim();
    if (keyword) {
      where.OR = [
        { content: { contains: keyword } },
        { ticket: { ticketNo: { contains: keyword } } },
        { user: { name: { contains: keyword } } },
        { user: { phone: { contains: keyword } } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.penaltyAppeal.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ id: 'desc' }],
        include: {
          user: { select: { id: true, name: true, phone: true } },
          reviewer: { select: { id: true, name: true } },
          ticket: {
            select: {
              id: true,
              ticketNo: true,
              finalAmount: true,
              status: true,
              appealStatus: true,
            },
          },
        },
      }),
      this.prisma.penaltyAppeal.count({ where }),
    ]);

    return {
      data: data.map((x) => ({
        ...x,
        statusLabel: this.appealStatusLabelMap[x.status] || x.status,
        ticket: x.ticket
          ? {
              ...x.ticket,
              statusLabel: this.ticketStatusLabelMap[x.ticket.status] || x.ticket.status,
              appealStatusLabel: this.appealStatusLabelMap[x.ticket.appealStatus] || x.ticket.appealStatus,
            }
          : x.ticket,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      dict: {
        appealStatusLabelMap: this.appealStatusLabelMap,
        ticketStatusLabelMap: this.ticketStatusLabelMap,
      },
    };
  }

  async getAdminPendingStats() {
    const [pendingConfirmCount, appealPendingCount, todayCreatedCount] = await Promise.all([
      this.prisma.penaltyTicket.count({
        where: { status: PenaltyTicketStatus.PENDING_CONFIRM },
      }),
      this.prisma.penaltyTicket.count({
        where: { status: PenaltyTicketStatus.APPEAL_PENDING },
      }),
      this.prisma.penaltyTicket.count({
        where: {
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
    ]);

    return {
      pendingConfirmCount,
      appealPendingCount,
      todayCreatedCount,
      totalPendingCount: pendingConfirmCount + appealPendingCount,
    };
  }

  async getAdminOverview() {
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const [pendingStats, ticketRows, detailRows] = await Promise.all([
      this.getAdminPendingStats(),
      this.prisma.penaltyTicket.findMany({
        where: { createdAt: { gte: sevenDaysAgo } },
        select: {
          id: true,
          createdAt: true,
          status: true,
          finalAmount: true,
          deductedAmount: true,
          deductedAt: true,
        },
        orderBy: [{ createdAt: 'asc' }],
      }),
      this.prisma.penaltyTicketDetail.findMany({
        where: {
          ticket: {
            createdAt: { gte: sevenDaysAgo },
          },
        },
        select: {
          ruleId: true,
          ruleNameSnapshot: true,
          amount: true,
        },
      }),
    ]);

    const dayBuckets: Record<string, { date: string; createdCount: number; effectiveCount: number; invalidCount: number; deductedAmount: number }> = {};
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(sevenDaysAgo);
      d.setDate(sevenDaysAgo.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      dayBuckets[key] = {
        date: key,
        createdCount: 0,
        effectiveCount: 0,
        invalidCount: 0,
        deductedAmount: 0,
      };
    }

    let totalProcessHours = 0;
    let processedCount = 0;

    for (const row of ticketRows) {
      const key = new Date(row.createdAt).toISOString().slice(0, 10);
      if (!dayBuckets[key]) continue;
      dayBuckets[key].createdCount += 1;
      if (row.status === PenaltyTicketStatus.EFFECTIVE) dayBuckets[key].effectiveCount += 1;
      if (row.status === PenaltyTicketStatus.INVALID) dayBuckets[key].invalidCount += 1;
      dayBuckets[key].deductedAmount += Number(row.deductedAmount || 0);

      if (row.deductedAt) {
        const processMs = new Date(row.deductedAt).getTime() - new Date(row.createdAt).getTime();
        if (processMs >= 0) {
          totalProcessHours += processMs / (1000 * 60 * 60);
          processedCount += 1;
        }
      }
    }

    const ruleCountMap = new Map<string, { ruleName: string; count: number; amount: number }>();
    for (const detail of detailRows) {
      const key = String(detail.ruleId || detail.ruleNameSnapshot || 'UNKNOWN');
      const prev = ruleCountMap.get(key) || { ruleName: detail.ruleNameSnapshot, count: 0, amount: 0 };
      prev.count += 1;
      prev.amount += Number(detail.amount || 0);
      ruleCountMap.set(key, prev);
    }

    const topRules = Array.from(ruleCountMap.values())
      .sort((a, b) => (b.count - a.count) || (b.amount - a.amount))
      .slice(0, 10)
      .map((x, idx) => ({
        rank: idx + 1,
        ruleName: x.ruleName,
        count: x.count,
        amount: this.round1(x.amount),
      }));

    return {
      pending: pendingStats,
      process: {
        avgProcessHours: processedCount ? this.round1(totalProcessHours / processedCount) : 0,
        processedCount,
      },
      trend7d: Object.values(dayBuckets),
      topRules,
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

    return {
      data: data.map((x) => ({
        ...x,
        bizTypeLabel: this.fundBizTypeLabelMap[x.bizType] || x.bizType,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      dict: {
        fundBizTypeLabelMap: this.fundBizTypeLabelMap,
      },
    };
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

  async getRuleCategoryStats(userId: number) {
    const uid = Number(userId);
    if (!uid) throw new BadRequestException('userId不能为空');

    const grouped = await this.prisma.penaltyTicketDetail.groupBy({
      by: ['ruleCategorySnapshot'],
      where: {
        ticket: {
          userId: uid,
          status: {
            in: [
              PenaltyTicketStatus.PENDING_CONFIRM,
              PenaltyTicketStatus.APPEAL_PENDING,
              PenaltyTicketStatus.EFFECTIVE,
            ],
          },
        },
      },
      _count: { _all: true },
    });

    const result: Record<PenaltyRuleCategory, number> = {
      SERVICE: 0,
      ATTENDANCE: 0,
      DISCIPLINE: 0,
      SAFETY: 0,
      OTHER: 0,
    };
    for (const row of grouped) {
      result[row.ruleCategorySnapshot] = Number(row._count?._all || 0);
    }
    return {
      value: result,
      labelValue: Object.fromEntries(
        Object.keys(result).map((k) => [
          this.categoryLabelMap[k as PenaltyRuleCategory] || k,
          result[k as PenaltyRuleCategory],
        ]),
      ),
      dict: {
        categoryLabelMap: this.categoryLabelMap,
      },
    };
  }

  // 手动催办：管理端可对指定罚单再次触发强提醒
  async remindTicket(ticketId: number, operatorId?: number) {
    const id = Number(ticketId);
    if (!id) throw new BadRequestException('ticketId不能为空');

    const ticket = await this.prisma.penaltyTicket.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('罚单不存在');
    const pendingStatuses: PenaltyTicketStatus[] = [
      PenaltyTicketStatus.PENDING_CONFIRM,
      PenaltyTicketStatus.APPEAL_PENDING,
    ];
    if (!pendingStatuses.includes(ticket.status)) {
      throw new BadRequestException('当前状态无需催办');
    }

    if (ticket.status === PenaltyTicketStatus.PENDING_CONFIRM) {
      await this.pushPenaltyStrongReminder({
        userId: ticket.userId,
        ticketId: ticket.id,
        ticketNo: ticket.ticketNo,
        amount: Number(ticket.finalAmount),
        title: `【催办】请优先处理罚单`,
        content: `罚单号 ${ticket.ticketNo} 仍待处理，请尽快确认或申诉。`,
      });
    } else {
      await this.pushAppealReviewReminderToAdmins({
        ticketId: ticket.id,
        ticketNo: ticket.ticketNo,
        userId: ticket.userId,
      });
    }

    this.remindCooldownMap.set(ticket.id, Date.now());
    if (operatorId) {
      await this.userLogsService.writeLog({
        userId: Number(operatorId),
        action: 'PENALTY_TICKET_REMIND',
        targetType: 'PENALTY_TICKET',
        targetId: ticket.id,
        remark: `手动催办罚单：${ticket.ticketNo}`,
      });
    }
    return { success: true };
  }

  // 自动催办：每10分钟扫描待处理罚单，并按冷却策略推送，减少遗漏
  @Cron('0 */10 * * * *', { timeZone: 'Asia/Shanghai' })
  async autoRemindPendingTickets() {
    const now = Date.now();
    const rows = await this.prisma.penaltyTicket.findMany({
      where: {
        status: {
          in: [PenaltyTicketStatus.PENDING_CONFIRM, PenaltyTicketStatus.APPEAL_PENDING],
        },
      },
      select: {
        id: true,
        userId: true,
        ticketNo: true,
        finalAmount: true,
        status: true,
      },
      orderBy: [{ id: 'desc' }],
      take: 200,
    });

    for (const row of rows) {
      const lastAt = Number(this.remindCooldownMap.get(row.id) || 0);
      if (now - lastAt < this.remindCooldownMs) continue;

      try {
        if (row.status === PenaltyTicketStatus.PENDING_CONFIRM) {
          await this.pushPenaltyStrongReminder({
            userId: row.userId,
            ticketId: row.id,
            ticketNo: row.ticketNo,
            amount: Number(row.finalAmount),
            title: `【强提醒】你有待处理罚单`,
            content: `罚单号 ${row.ticketNo} 仍在待处理状态，请优先处理。`,
          });
        } else if (row.status === PenaltyTicketStatus.APPEAL_PENDING) {
          await this.pushAppealReviewReminderToAdmins({
            ticketId: row.id,
            ticketNo: row.ticketNo,
            userId: row.userId,
          });
        }
        this.remindCooldownMap.set(row.id, now);
      } catch (e) {
        // 定时任务不抛出，避免影响后续任务轮次
        console.error('[penalties][autoRemindPendingTickets] failed:', row.id, e?.message || e);
      }
    }
  }
}
