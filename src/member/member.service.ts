import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MemberPointBizType, MemberPointDirection, Prisma, PrismaClient, UserType, WechatBindingPlatform } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { WechatPayService } from '../mini/wechat-pay.service';
import { SystemConfigService } from '../system-config/system-config.service';

type PrismaTx = PrismaClient | Prisma.TransactionClient;

@Injectable()
export class MemberService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly wechatPayService: WechatPayService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  private getDb(tx?: PrismaTx) {
    return (tx as any) ?? this.prisma;
  }

  private toAmount(value: Prisma.Decimal | number | string | null | undefined) {
    return Number(value ?? 0);
  }

  private round2(value: number) {
    return Math.round(Number(value || 0) * 100) / 100;
  }

  private buildMemberCode(userId: number) {
    return `BM${String(userId).padStart(8, '0')}`;
  }

  private normalizeLevelCode(code: string) {
    return String(code || '').trim().toUpperCase();
  }

  private normalizeBenefits(input: any) {
    if (Array.isArray(input)) {
      return input
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 50);
    }
    if (typeof input === 'string') {
      return input
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 50);
    }
    return [];
  }

  private normalizePaymentTestWhitelist(input: any) {
    const toStringList = (list: any) =>
      (Array.isArray(list) ? list : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    const toNumberList = (list: any) =>
      (Array.isArray(list) ? list : [])
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0)
        .map((item) => Math.floor(item));

    if (Array.isArray(input)) {
      return {
        userIds: [],
        phones: toStringList(input),
        openIds: [],
        unionIds: [],
      };
    }

    const row = input && typeof input === 'object' ? input : {};
    return {
      userIds: toNumberList(row.userIds),
      phones: toStringList(row.phones),
      openIds: toStringList(row.openIds),
      unionIds: toStringList(row.unionIds),
    };
  }

  private async getPaymentTestWhitelist() {
    const raw = await this.systemConfigService.getJson<any>(
      SystemConfigService.KEYS.WECHAT_PAY_TEST_WHITELIST,
      { userIds: [], phones: [], openIds: [], unionIds: [] },
    );
    return this.normalizePaymentTestWhitelist(raw);
  }

  private toLevelView(config: any) {
    return {
      ...config,
      minRechargeAmount: this.toAmount(config?.minRechargeAmount),
      minAnnualContribution: Number(config?.minAnnualContribution || 0),
      benefits: this.normalizeBenefits(config?.benefits),
    };
  }

  private async ensureDefaultLevelConfigs(tx?: PrismaTx) {
    const db = this.getDb(tx);
    const count = await db.memberLevelConfig.count();
    if (count > 0) return;

    await db.memberLevelConfig.createMany({
      data: [
        {
          code: 'NONE',
          name: '普通会员',
          sortOrder: 0,
          minRechargeAmount: 0,
          minAnnualContribution: 0,
          benefits: ['基础会员身份'],
          enabled: true,
          isDefault: true,
        },
        {
          code: 'V1',
          name: '储值会员',
          sortOrder: 100,
          minRechargeAmount: 100,
          minAnnualContribution: 0,
          benefits: ['充值送余额', '积分可抵扣'],
          enabled: true,
          isDefault: false,
        },
        {
          code: 'V2',
          name: '黄金会员',
          sortOrder: 200,
          minRechargeAmount: 500,
          minAnnualContribution: 0,
          benefits: ['高阶会员价', '专属券包'],
          enabled: true,
          isDefault: false,
        },
        {
          code: 'V3',
          name: '黑金会员',
          sortOrder: 300,
          minRechargeAmount: 1000,
          minAnnualContribution: 0,
          benefits: ['高额储值礼', '优先服务'],
          enabled: true,
          isDefault: false,
        },
      ],
    });
  }

  private async resolveLevelConfig(totalRechargeAmount: number, annualContribution: number, tx?: PrismaTx) {
    const db = this.getDb(tx);
    await this.ensureDefaultLevelConfigs(tx);
    const configs = await db.memberLevelConfig.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });

    let matched = configs.find((item: any) => item.isDefault) || configs[0] || null;
    for (const config of configs) {
      if (
        totalRechargeAmount >= this.toAmount(config.minRechargeAmount) &&
        annualContribution >= Number(config.minAnnualContribution || 0)
      ) {
        matched = config;
      }
    }
    return matched;
  }

  async ensureMemberProfile(userId: number, tx?: PrismaTx) {
    const db = this.getDb(tx);
    await this.ensureDefaultLevelConfigs(tx);
    const exists = await db.memberProfile.findUnique({ where: { userId } });
    if (exists) return exists;
    const defaultLevel = await this.resolveLevelConfig(0, 0, tx);
    return db.memberProfile.create({
      data: {
        userId,
        memberCode: this.buildMemberCode(userId),
        levelCode: String(defaultLevel?.code || 'NONE'),
      },
    });
  }

  async ensurePointAccount(userId: number, tx?: PrismaTx) {
    const db = this.getDb(tx);
    const exists = await db.memberPointAccount.findUnique({ where: { userId } });
    if (exists) return exists;
    return db.memberPointAccount.create({
      data: { userId },
    });
  }

  async ensureUserAssets(userId: number, tx?: PrismaTx) {
    await Promise.all([
      this.walletService.ensureWalletAccount(userId, tx),
      this.ensureMemberProfile(userId, tx),
      this.ensurePointAccount(userId, tx),
    ]);
  }

  async upsertWechatBinding(input: {
    userId: number;
    appId: string;
    openId: string;
    unionId?: string;
    sessionKey?: string;
    nickname?: string;
    avatarUrl?: string;
    platform?: WechatBindingPlatform;
  }, tx?: PrismaTx) {
    const db = this.getDb(tx);
    const platform = input.platform ?? WechatBindingPlatform.MINIAPP;
    const openId = String(input.openId || '').trim();
    const appId = String(input.appId || '').trim();
    if (!openId || !appId) throw new BadRequestException('微信绑定参数缺失');

    const existingByOpenId = await db.userWechatBinding.findUnique({
      where: {
        platform_appId_openId: {
          platform,
          appId,
          openId,
        },
      },
    });

    if (existingByOpenId && Number(existingByOpenId.userId) !== Number(input.userId)) {
      throw new BadRequestException('该微信账号已绑定其他用户');
    }

    return db.userWechatBinding.upsert({
      where: {
        platform_appId_openId: {
          platform,
          appId,
          openId,
        },
      },
      create: {
        userId: input.userId,
        platform,
        appId,
        openId,
        unionId: input.unionId ? String(input.unionId).trim() : null,
        sessionKey: input.sessionKey ? String(input.sessionKey).trim() : null,
        nickname: input.nickname ? String(input.nickname).trim() : null,
        avatarUrl: input.avatarUrl ? String(input.avatarUrl).trim() : null,
        lastLoginAt: new Date(),
        lastBindAt: new Date(),
      },
      update: {
        userId: input.userId,
        unionId: input.unionId ? String(input.unionId).trim() : null,
        sessionKey: input.sessionKey ? String(input.sessionKey).trim() : null,
        nickname: input.nickname ? String(input.nickname).trim() : null,
        avatarUrl: input.avatarUrl ? String(input.avatarUrl).trim() : null,
        lastLoginAt: new Date(),
        lastBindAt: new Date(),
      },
    });
  }

  async findUserByWechatBinding(appId: string, openId: string, platform = WechatBindingPlatform.MINIAPP) {
    const binding = await this.prisma.userWechatBinding.findUnique({
      where: {
        platform_appId_openId: {
          platform,
          appId,
          openId,
        },
      },
      include: {
        user: true,
      },
    });
    return binding?.user || null;
  }

  async findLatestWechatBinding(userId: number) {
    return this.prisma.userWechatBinding.findFirst({
      where: { userId, platform: WechatBindingPlatform.MINIAPP },
      orderBy: [{ lastLoginAt: 'desc' as const }, { updatedAt: 'desc' as const }],
    });
  }

  async addPoints(input: {
    userId: number;
    points: number;
    bizType: MemberPointBizType;
    sourceType: string;
    sourceId?: number;
    remark?: string;
  }, tx?: PrismaTx) {
    const db = this.getDb(tx);
    const points = Math.max(0, Math.floor(Number(input.points || 0)));
    if (points <= 0) return null;

    await this.ensurePointAccount(input.userId, tx);
    const account = await db.memberPointAccount.update({
      where: { userId: input.userId },
      data: {
        availablePoints: { increment: points },
        totalEarnedPoints: { increment: points },
      },
    });

    return db.memberPointTransaction.create({
      data: {
        userId: input.userId,
        direction: MemberPointDirection.IN,
        bizType: input.bizType,
        points,
        balanceAfter: Number(account.availablePoints),
        sourceType: String(input.sourceType || 'UNKNOWN').trim().slice(0, 32),
        sourceId: input.sourceId ?? null,
        remark: input.remark ? String(input.remark).slice(0, 255) : null,
      },
    });
  }

  async adjustPoints(input: {
    userId: number;
    points: number;
    remark?: string;
  }) {
    const points = Math.trunc(Number(input.points || 0));
    if (!points) throw new BadRequestException('积分调整值不能为 0');

    return this.prisma.$transaction(async (tx) => {
      await this.ensureUserAssets(input.userId, tx as any);
      if (points > 0) {
        return this.addPoints({
          userId: input.userId,
          points,
          bizType: MemberPointBizType.ADMIN_ADJUST,
          sourceType: 'ADMIN_ADJUST',
          remark: input.remark || '后台人工调整积分',
        }, tx as any);
      }

      const account = await tx.memberPointAccount.findUnique({ where: { userId: input.userId } });
      const spend = Math.abs(points);
      if (!account || Number(account.availablePoints) < spend) {
        throw new BadRequestException('积分不足，无法扣减');
      }

      const updated = await tx.memberPointAccount.update({
        where: { userId: input.userId },
        data: {
          availablePoints: { decrement: spend },
          totalSpentPoints: { increment: spend },
        },
      });

      return tx.memberPointTransaction.create({
        data: {
          userId: input.userId,
          direction: MemberPointDirection.OUT,
          bizType: MemberPointBizType.ADMIN_ADJUST,
          points: spend,
          balanceAfter: Number(updated.availablePoints),
          sourceType: 'ADMIN_ADJUST',
          remark: input.remark || '后台人工扣减积分',
        },
      });
    });
  }

  async listPointTransactions(userId: number, query: { page?: number; limit?: number }) {
    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.memberPointTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' as const },
        skip,
        take: limit,
      }),
      this.prisma.memberPointTransaction.count({ where: { userId } }),
    ]);

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async listRechargePlans(enabledOnly = false) {
    return this.prisma.memberRechargePlan.findMany({
      where: enabledOnly ? { enabled: true } : undefined,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
  }

  async listLevelConfigs() {
    await this.ensureDefaultLevelConfigs();
    const configs = await this.prisma.memberLevelConfig.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return configs.map((item) => this.toLevelView(item));
  }

  async createLevelConfig(data: any) {
    await this.ensureDefaultLevelConfigs();
    const code = this.normalizeLevelCode(data?.code);
    if (!code) throw new BadRequestException('等级编码不能为空');
    const exists = await this.prisma.memberLevelConfig.findUnique({ where: { code } });
    if (exists) throw new BadRequestException('等级编码已存在');

    const created = await this.prisma.memberLevelConfig.create({
      data: {
        code,
        name: String(data?.name || code).trim().slice(0, 64),
        sortOrder: Math.floor(Number(data?.sortOrder ?? 100)),
        minRechargeAmount: this.round2(Number(data?.minRechargeAmount || 0)),
        minAnnualContribution: Math.max(0, Math.floor(Number(data?.minAnnualContribution || 0))),
        benefits: this.normalizeBenefits(data?.benefits),
        description: data?.description ? String(data.description).trim().slice(0, 255) : null,
        enabled: data?.enabled !== false,
        isDefault: !!data?.isDefault,
      },
    });

    if (created.isDefault) {
      await this.prisma.memberLevelConfig.updateMany({
        where: { id: { not: created.id }, isDefault: true },
        data: { isDefault: false },
      });
    }

    return this.toLevelView(created);
  }

  private async assertLevelThresholdAdjustable(levelId: number, nextThresholdRecharge: number, nextThresholdContribution: number) {
    const current = await this.prisma.memberLevelConfig.findUnique({ where: { id: levelId } });
    if (!current) throw new NotFoundException('会员等级不存在');

    const higherLevels = await this.prisma.memberLevelConfig.findMany({
      where: {
        enabled: true,
        sortOrder: { gt: current.sortOrder },
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const nextLevel = higherLevels[0];
    if (!nextLevel) return;

    const matchedCount = await this.prisma.memberProfile.count({
      where: {
        levelCode: current.code,
        OR: [
          { totalRechargeAmount: { gte: nextThresholdRecharge } as any },
          { annualContribution: { gte: nextThresholdContribution } },
        ],
      },
    });
    if (matchedCount > 0) {
      throw new BadRequestException('当前等级下存在已达标可升级会员，暂不可调整该等级门槛');
    }
  }

  async updateLevelConfig(id: number, data: any) {
    await this.ensureDefaultLevelConfigs();
    const current = await this.prisma.memberLevelConfig.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('会员等级不存在');

    const nextRecharge = data?.minRechargeAmount !== undefined ? this.round2(Number(data.minRechargeAmount || 0)) : this.toAmount(current.minRechargeAmount);
    const nextContribution = data?.minAnnualContribution !== undefined ? Math.max(0, Math.floor(Number(data.minAnnualContribution || 0))) : Number(current.minAnnualContribution || 0);

    if (data?.minRechargeAmount !== undefined || data?.minAnnualContribution !== undefined) {
      await this.assertLevelThresholdAdjustable(id, nextRecharge, nextContribution);
    }

    const updated = await this.prisma.memberLevelConfig.update({
      where: { id },
      data: {
        code: data?.code !== undefined ? this.normalizeLevelCode(data.code) : undefined,
        name: data?.name !== undefined ? String(data.name || '').trim().slice(0, 64) : undefined,
        sortOrder: data?.sortOrder !== undefined ? Math.floor(Number(data.sortOrder || 100)) : undefined,
        minRechargeAmount: data?.minRechargeAmount !== undefined ? nextRecharge : undefined,
        minAnnualContribution: data?.minAnnualContribution !== undefined ? nextContribution : undefined,
        benefits: data?.benefits !== undefined ? this.normalizeBenefits(data.benefits) : undefined,
        description: data?.description !== undefined ? (data.description ? String(data.description).trim().slice(0, 255) : null) : undefined,
        enabled: data?.enabled !== undefined ? !!data.enabled : undefined,
        isDefault: data?.isDefault !== undefined ? !!data.isDefault : undefined,
      },
    });

    if (updated.isDefault) {
      await this.prisma.memberLevelConfig.updateMany({
        where: { id: { not: updated.id }, isDefault: true },
        data: { isDefault: false },
      });
    }

    await this.refreshMemberLevels();
    return this.toLevelView(updated);
  }

  async refreshMemberLevels() {
    await this.ensureDefaultLevelConfigs();
    const profiles = await this.prisma.memberProfile.findMany({
      select: {
        userId: true,
        totalRechargeAmount: true,
        annualContribution: true,
      },
    });

    for (const profile of profiles) {
      const resolved = await this.resolveLevelConfig(
        this.toAmount(profile.totalRechargeAmount),
        Number(profile.annualContribution || 0),
      );
      await this.prisma.memberProfile.update({
        where: { userId: profile.userId },
        data: {
          levelCode: String(resolved?.code || 'NONE'),
        },
      });
    }
    return { success: true, count: profiles.length };
  }

  async createRechargePlan(data: any) {
    const amount = this.round2(Number(data?.amount || 0));
    if (amount <= 0) throw new BadRequestException('充值金额必须大于 0');
    return this.prisma.memberRechargePlan.create({
      data: {
        title: String(data?.title || `充${amount}元`).trim().slice(0, 64),
        amount,
        bonusAmount: this.round2(Number(data?.bonusAmount || 0)),
        giftPoints: Math.max(0, Math.floor(Number(data?.giftPoints || 0))),
        couponText: data?.couponText ? String(data.couponText).trim().slice(0, 120) : null,
        badgeText: data?.badgeText ? String(data.badgeText).trim().slice(0, 32) : null,
        sortOrder: Math.floor(Number(data?.sortOrder ?? 100)),
        enabled: data?.enabled !== false,
      },
    });
  }

  async updateRechargePlan(id: number, data: any) {
    const exists = await this.prisma.memberRechargePlan.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('充值方案不存在');
    return this.prisma.memberRechargePlan.update({
      where: { id },
      data: {
        title: data?.title !== undefined ? String(data.title || '').trim().slice(0, 64) : undefined,
        amount: data?.amount !== undefined ? this.round2(Number(data.amount || 0)) : undefined,
        bonusAmount: data?.bonusAmount !== undefined ? this.round2(Number(data.bonusAmount || 0)) : undefined,
        giftPoints: data?.giftPoints !== undefined ? Math.max(0, Math.floor(Number(data.giftPoints || 0))) : undefined,
        couponText: data?.couponText !== undefined ? (data.couponText ? String(data.couponText).trim().slice(0, 120) : null) : undefined,
        badgeText: data?.badgeText !== undefined ? (data.badgeText ? String(data.badgeText).trim().slice(0, 32) : null) : undefined,
        sortOrder: data?.sortOrder !== undefined ? Math.floor(Number(data.sortOrder || 100)) : undefined,
        enabled: data?.enabled !== undefined ? !!data.enabled : undefined,
      },
    });
  }

  private buildRechargeNo(userId: number) {
    const stamp = Date.now();
    return `RC${userId}${stamp}`;
  }

  async createRechargeOrder(userId: number, body: { planId?: number; amount?: number; payerOpenid?: string }) {
    await this.ensureUserAssets(userId);

    let plan: any = null;
    if (body?.planId) {
      plan = await this.prisma.memberRechargePlan.findUnique({ where: { id: Number(body.planId) } });
      if (!plan || !plan.enabled) throw new BadRequestException('充值方案不存在或已停用');
    }

    const amount = this.round2(plan ? this.toAmount(plan.amount) : Number(body?.amount || 0));
    if (amount <= 0) throw new BadRequestException('充值金额必须大于 0');

    const bonusAmount = this.round2(plan ? this.toAmount(plan.bonusAmount) : 0);
    const giftPoints = Math.max(0, plan ? Number(plan.giftPoints || 0) : 0);
    const grantedAmount = this.round2(amount + bonusAmount);

    return this.prisma.memberRechargeOrder.create({
      data: {
        rechargeNo: this.buildRechargeNo(userId),
        userId,
        planId: plan?.id ?? null,
        amount,
        bonusAmount,
        grantedAmount,
        giftPoints,
        payAmount: amount,
        payerOpenid: body?.payerOpenid ? String(body.payerOpenid).trim() : null,
      },
    });
  }

  async createRechargePrepay(userId: number, rechargeOrderId: number, body: { payerOpenid?: string; notifyUrl?: string; testMode?: boolean }) {
    const order = await this.prisma.memberRechargeOrder.findFirst({
      where: { id: rechargeOrderId, userId },
    });
    if (!order) throw new NotFoundException('充值订单不存在');
    if (order.status === 'SUCCESS') throw new BadRequestException('充值订单已支付');

    const payerOpenid = String(body?.payerOpenid || order.payerOpenid || '').trim();
    if (!payerOpenid) throw new BadRequestException('缺少 payerOpenid');

    const prepay = await this.wechatPayService.createJsapiPrepay({
      orderNo: order.rechargeNo,
      description: `会员充值${this.toAmount(order.payAmount).toFixed(2)}元`,
      totalFeeFen: Math.max(1, Math.round(this.toAmount(order.payAmount) * 100)),
      payerOpenid,
      notifyUrl: body?.notifyUrl ? String(body.notifyUrl).trim() : undefined,
      useTestAmount: Boolean(body?.testMode) && await this.canUseMiniPaymentTestMode(userId),
    });

    await this.prisma.memberRechargeOrder.update({
      where: { id: order.id },
      data: {
        payerOpenid,
        prepayId: String(prepay?.params?.package || '').replace(/^prepay_id=/, ''),
      },
    });

    return {
      rechargeOrderId: order.id,
      rechargeNo: order.rechargeNo,
      ...prepay,
    };
  }

  async settleRechargeSuccess(rechargeNo: string, payload: {
    transactionId?: string;
    payerOpenid?: string;
    notifyRaw?: any;
  }) {
    const order = await this.prisma.memberRechargeOrder.findUnique({
      where: { rechargeNo },
    });
    if (!order) throw new NotFoundException('充值订单不存在');
    if (order.status === 'SUCCESS') return order;

    return this.prisma.$transaction(async (tx) => {
      await this.ensureUserAssets(order.userId, tx as any);

      const settled = await tx.memberRechargeOrder.update({
        where: { id: order.id },
        data: {
          status: 'SUCCESS',
          paidAt: new Date(),
          transactionId: payload.transactionId ? String(payload.transactionId).trim() : null,
          payerOpenid: payload.payerOpenid ? String(payload.payerOpenid).trim() : order.payerOpenid,
          notifyRaw: payload.notifyRaw ?? undefined,
        },
      });

      const walletSourceId = Number(order.id);
      await this.walletService.creditAvailableBalance({
        userId: order.userId,
        amount: this.toAmount(order.payAmount),
        bizType: 'MEMBER_RECHARGE' as any,
        sourceType: 'MEMBER_RECHARGE_ORDER',
        sourceId: walletSourceId * 10 + 1,
        remark: `会员充值本金 ${this.toAmount(order.payAmount).toFixed(2)} 元`,
      }, tx as any);

      if (this.toAmount(order.bonusAmount) > 0) {
        await this.walletService.creditAvailableBalance({
          userId: order.userId,
          amount: this.toAmount(order.bonusAmount),
          bizType: 'MEMBER_RECHARGE_BONUS' as any,
          sourceType: 'MEMBER_RECHARGE_ORDER',
          sourceId: walletSourceId * 10 + 2,
          remark: `会员充值赠送 ${this.toAmount(order.bonusAmount).toFixed(2)} 元`,
        }, tx as any);
      }

      const profile = await tx.memberProfile.findUnique({ where: { userId: order.userId } });
      const totalRechargeAmount = this.round2(this.toAmount(profile?.totalRechargeAmount) + this.toAmount(order.payAmount));
      const annualContribution = Number(profile?.annualContribution || 0) + Math.max(0, Math.floor(this.toAmount(order.payAmount)));
      const levelConfig = await this.resolveLevelConfig(totalRechargeAmount, annualContribution, tx as any);
      await tx.memberProfile.update({
        where: { userId: order.userId },
        data: {
          totalRechargeAmount,
          annualContribution,
          lastRechargeAt: new Date(),
          levelCode: String(levelConfig?.code || 'NONE'),
        },
      });

      if (Number(order.giftPoints || 0) > 0) {
        await this.addPoints({
          userId: order.userId,
          points: Number(order.giftPoints || 0),
          bizType: MemberPointBizType.RECHARGE_GIFT,
          sourceType: 'MEMBER_RECHARGE_ORDER',
          sourceId: order.id,
          remark: `充值赠送积分 ${order.giftPoints}`,
        }, tx as any);
      }

      return settled;
    });
  }

  async getMiniOverview(userId: number) {
    await this.ensureUserAssets(userId);

    const [user, wallet, profile, pointAccount, bindings, rechargePlans, levelConfigs] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          phone: true,
          name: true,
          avatar: true,
        },
      }),
      this.prisma.walletAccount.findUnique({ where: { userId } }),
      this.prisma.memberProfile.findUnique({ where: { userId } }),
      this.prisma.memberPointAccount.findUnique({ where: { userId } }),
      this.prisma.userWechatBinding.findMany({
        where: { userId },
        orderBy: [{ lastLoginAt: 'desc' as const }, { updatedAt: 'desc' as const }],
      }),
      this.listRechargePlans(true),
      this.listLevelConfigs(),
    ]);
    const currentLevel = levelConfigs.find((item: any) => item.code === profile?.levelCode) || null;
    const paymentTestAllowed = await this.canUseMiniPaymentTestMode(userId, { user, bindings });

    return {
      user: user || null,
      wallet: wallet || null,
      member: {
        ...(profile || {}),
        levelName: currentLevel?.name || profile?.levelCode || '普通会员',
        levelCode: profile?.levelCode || 'NONE',
        rights: currentLevel?.benefits || [],
      },
      points: pointAccount || null,
      wechat: {
        bindings,
        miniOpenid: bindings.find((item) => item.platform === WechatBindingPlatform.MINIAPP)?.openId || null,
        unionId: bindings.find((item) => !!item.unionId)?.unionId || null,
        nickname: bindings.find((item) => !!item.nickname)?.nickname || null,
        avatarUrl: bindings.find((item) => !!item.avatarUrl)?.avatarUrl || null,
      },
      rechargePlans: rechargePlans.map((plan) => ({
        ...plan,
        amount: this.toAmount(plan.amount),
        bonusAmount: this.toAmount(plan.bonusAmount),
        totalAmount: this.round2(this.toAmount(plan.amount) + this.toAmount(plan.bonusAmount)),
      })),
      paymentTest: {
        allowed: paymentTestAllowed,
        title: '测试支付 0.01 元',
        remark: '仅对白名单账号生效，开启后订单与充值将按 0.01 元发起真实微信支付',
      },
      memberLevels: levelConfigs,
    };
  }

  async canUseMiniPaymentTestMode(
    userId: number,
    options?: {
      user?: { id?: number; phone?: string | null } | null;
      bindings?: Array<{ openId?: string | null; unionId?: string | null }> | null;
    },
  ) {
    const enabled = await this.systemConfigService.getBoolean(
      SystemConfigService.KEYS.WECHAT_PAY_TEST_ENABLED,
      false,
    );
    if (!enabled) return false;

    const whitelist = await this.getPaymentTestWhitelist();
    if (
      !whitelist.userIds.length &&
      !whitelist.phones.length &&
      !whitelist.openIds.length &&
      !whitelist.unionIds.length
    ) {
      return false;
    }

    const user = options?.user ?? await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true },
    });
    const bindings = options?.bindings ?? await this.prisma.userWechatBinding.findMany({
      where: { userId },
      select: { openId: true, unionId: true },
      orderBy: [{ lastLoginAt: 'desc' as const }, { updatedAt: 'desc' as const }],
    });

    const phone = String(user?.phone || '').trim();
    const openIds = new Set((Array.isArray(bindings) ? bindings : []).map((item) => String(item?.openId || '').trim()).filter(Boolean));
    const unionIds = new Set((Array.isArray(bindings) ? bindings : []).map((item) => String(item?.unionId || '').trim()).filter(Boolean));

    return (
      whitelist.userIds.includes(Number(user?.id || userId)) ||
      (phone ? whitelist.phones.includes(phone) : false) ||
      whitelist.openIds.some((item) => openIds.has(item)) ||
      whitelist.unionIds.some((item) => unionIds.has(item))
    );
  }

  async getAdminUserAssets(userId: number) {
    await this.ensureUserAssets(userId);
    const [profile, pointAccount, bindings] = await Promise.all([
      this.prisma.memberProfile.findUnique({ where: { userId } }),
      this.prisma.memberPointAccount.findUnique({ where: { userId } }),
      this.prisma.userWechatBinding.findMany({
        where: { userId },
        orderBy: [{ lastLoginAt: 'desc' as const }, { updatedAt: 'desc' as const }],
      }),
    ]);

    return {
      memberProfile: profile,
      memberPointAccount: pointAccount,
      wechatBindings: bindings,
    };
  }

  async exchangeWechatCode(code: string) {
    const appid = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_MINI_APPID,
      String(process.env.WECHAT_MINI_APPID || process.env.WECHAT_PAY_APPID || '').trim(),
    );
    const secret = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_MINI_APPSECRET,
      String(process.env.WECHAT_MINI_APPSECRET || '').trim(),
    );
    if (!appid || !secret) {
      throw new BadRequestException('未配置微信登录参数');
    }

    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const resp = await fetch(url);
    const data: any = await resp.json();
    const openId = String(data?.openid || '').trim();
    if (!openId) {
      throw new BadRequestException(data?.errmsg || '微信授权失败');
    }

    return {
      appId: appid,
      openId,
      unionId: String(data?.unionid || '').trim() || undefined,
      sessionKey: String(data?.session_key || '').trim() || undefined,
      nickname: undefined,
      avatarUrl: undefined,
      pseudoPhone: `wx_${createHash('md5').update(openId).digest('hex').slice(0, 20)}`,
    };
  }

  async getWechatMiniConfig() {
    const appId = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_MINI_APPID,
      String(process.env.WECHAT_MINI_APPID || process.env.WECHAT_PAY_APPID || '').trim(),
    );
    const appSecret = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_MINI_APPSECRET,
      String(process.env.WECHAT_MINI_APPSECRET || '').trim(),
    );
    return {
      appId: String(appId || '').trim(),
      appSecret: String(appSecret || '').trim(),
    };
  }

  async assertMiniPhoneBound(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    const phone = String(user?.phone || '').trim();
    if (!phone || phone.startsWith('wx_')) {
      throw new BadRequestException('请先完善资料并绑定手机号');
    }
  }

  async fetchWechatPhoneNumber(code: string) {
    const { appId, appSecret } = await this.getWechatMiniConfig();
    if (!appId || !appSecret) {
      throw new BadRequestException('未配置微信登录参数');
    }

    const tokenResp = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`,
    );
    const tokenData: any = await tokenResp.json();
    const accessToken = String(tokenData?.access_token || '').trim();
    if (!accessToken) {
      throw new BadRequestException(tokenData?.errmsg || '获取微信 access_token 失败');
    }

    const phoneResp = await fetch(
      `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: String(code || '').trim() }),
      },
    );
    const phoneData: any = await phoneResp.json();
    const phoneNumber = String(phoneData?.phone_info?.phoneNumber || '').trim();
    if (!phoneNumber) {
      throw new BadRequestException(phoneData?.errmsg || '获取微信手机号失败');
    }
    return phoneNumber;
  }

  async completeMiniProfile(
    userId: number,
    body: { nickname?: string; avatarUrl?: string; phoneCode?: string },
  ) {
    const nickname = String(body?.nickname || '').trim();
    const avatarUrl = String(body?.avatarUrl || '').trim();
    const phoneCode = String(body?.phoneCode || '').trim();

    let phone: string | null = null;
    if (phoneCode) {
      phone = await this.fetchWechatPhoneNumber(phoneCode);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        wechatBindings: {
          orderBy: [{ lastLoginAt: 'desc' as const }, { updatedAt: 'desc' as const }],
          take: 1,
        },
      },
    });
    if (!user) throw new NotFoundException('用户不存在');
    const shouldUpdateUserName = user.userType !== UserType.STAFF;

    let targetUserId = userId;
    const existingUser = phone && phone !== user.phone
      ? await this.prisma.user.findFirst({
          where: {
            phone,
            id: { not: userId },
          },
          select: { id: true },
        })
      : null;

    if (existingUser?.id) {
      targetUserId = await this.mergeMiniUserToExistingUser({
        sourceUserId: userId,
        targetUserId: existingUser.id,
        nickname,
        avatarUrl,
        phone: phone || undefined,
      });
      return {
        userId: targetUserId,
        merged: true,
      };
    }

    const latestBinding = Array.isArray(user.wechatBindings) ? user.wechatBindings[0] : null;
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          ...(shouldUpdateUserName ? { name: nickname || user.name } : {}),
          avatar: avatarUrl || user.avatar,
          phone: phone || user.phone,
        },
      });

      if (latestBinding) {
        await tx.userWechatBinding.update({
          where: { id: latestBinding.id },
          data: {
            nickname: nickname || latestBinding.nickname,
            avatarUrl: avatarUrl || latestBinding.avatarUrl,
          },
        });
      }
    });

    return {
      userId,
      merged: false,
    };
  }

  private async mergeMiniUserToExistingUser(input: {
    sourceUserId: number;
    targetUserId: number;
    nickname?: string;
    avatarUrl?: string;
    phone?: string;
  }) {
    const { sourceUserId, targetUserId, nickname, avatarUrl, phone } = input;
    if (sourceUserId === targetUserId) return targetUserId;

    await this.prisma.$transaction(async (tx) => {
      const [sourceUser, targetUser, sourceProfile, targetProfile, sourcePointAccount, targetPointAccount, sourceWallet, targetWallet] =
        await Promise.all([
          tx.user.findUnique({ where: { id: sourceUserId } }),
          tx.user.findUnique({ where: { id: targetUserId } }),
          tx.memberProfile.findUnique({ where: { userId: sourceUserId } }),
          tx.memberProfile.findUnique({ where: { userId: targetUserId } }),
          tx.memberPointAccount.findUnique({ where: { userId: sourceUserId } }),
          tx.memberPointAccount.findUnique({ where: { userId: targetUserId } }),
          tx.walletAccount.findUnique({ where: { userId: sourceUserId } }),
          tx.walletAccount.findUnique({ where: { userId: targetUserId } }),
        ]);

      if (!sourceUser || !targetUser) {
        throw new NotFoundException('用户不存在');
      }

      await tx.systemAnnouncementRead.deleteMany({
        where: {
          userId: sourceUserId,
          announcementId: {
            in: (
              await tx.systemAnnouncementRead.findMany({
                where: { userId: targetUserId },
                select: { announcementId: true },
              })
            ).map((item) => item.announcementId),
          },
        },
      });

      await tx.orderParticipant.deleteMany({
        where: {
          userId: sourceUserId,
          dispatchId: {
            in: (
              await tx.orderParticipant.findMany({
                where: { userId: targetUserId },
                select: { dispatchId: true },
              })
            ).map((item) => item.dispatchId),
          },
        },
      });

      await tx.orderSettlement.deleteMany({
        where: {
          userId: sourceUserId,
          OR: (
            await tx.orderSettlement.findMany({
              where: { userId: targetUserId },
              select: { dispatchId: true, settlementType: true },
            })
          ).map((item) => ({
            dispatchId: item.dispatchId,
            settlementType: item.settlementType,
          })),
        },
      });

      await tx.userWechatBinding.updateMany({
        where: { userId: sourceUserId },
        data: { userId: targetUserId },
      });
      await tx.userCoupon.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.userNotification.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.systemAnnouncementRead.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.recharge.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.memberPointTransaction.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.memberRechargeOrder.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.userLog.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.order.updateMany({ where: { dispatcherId: sourceUserId }, data: { dispatcherId: targetUserId } });
      await tx.productReview.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.orderParticipant.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.orderSettlement.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.walletTransaction.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.walletHold.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.walletWithdrawalRequest.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.chestUserAccount.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.chestOpenRecord.updateMany({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      await tx.chestPromoBundleItem.updateMany({ where: { assignedUserId: sourceUserId }, data: { assignedUserId: targetUserId } });

      if (sourceProfile && targetProfile) {
        await tx.memberProfile.update({
          where: { userId: targetUserId },
          data: {
            totalRechargeAmount: this.round2(this.toAmount(targetProfile.totalRechargeAmount) + this.toAmount(sourceProfile.totalRechargeAmount)),
            totalConsumeAmount: this.round2(this.toAmount(targetProfile.totalConsumeAmount) + this.toAmount(sourceProfile.totalConsumeAmount)),
            annualContribution: Number(targetProfile.annualContribution || 0) + Number(sourceProfile.annualContribution || 0),
            lastRechargeAt: targetProfile.lastRechargeAt || sourceProfile.lastRechargeAt,
          },
        });
        await tx.memberProfile.delete({ where: { userId: sourceUserId } });
      } else if (sourceProfile && !targetProfile) {
        await tx.memberProfile.update({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      }

      if (sourcePointAccount && targetPointAccount) {
        await tx.memberPointAccount.update({
          where: { userId: targetUserId },
          data: {
            availablePoints: Number(targetPointAccount.availablePoints || 0) + Number(sourcePointAccount.availablePoints || 0),
            totalEarnedPoints: Number(targetPointAccount.totalEarnedPoints || 0) + Number(sourcePointAccount.totalEarnedPoints || 0),
            totalSpentPoints: Number(targetPointAccount.totalSpentPoints || 0) + Number(sourcePointAccount.totalSpentPoints || 0),
          },
        });
        await tx.memberPointAccount.delete({ where: { userId: sourceUserId } });
      } else if (sourcePointAccount && !targetPointAccount) {
        await tx.memberPointAccount.update({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      }

      if (sourceWallet && targetWallet) {
        await tx.walletAccount.update({
          where: { userId: targetUserId },
          data: {
            availableBalance: this.round2(this.toAmount(targetWallet.availableBalance) + this.toAmount(sourceWallet.availableBalance)),
            frozenBalance: this.round2(this.toAmount(targetWallet.frozenBalance) + this.toAmount(sourceWallet.frozenBalance)),
            depositBalance: this.round2(this.toAmount(targetWallet.depositBalance) + this.toAmount(sourceWallet.depositBalance)),
          },
        });
        await tx.walletAccount.delete({ where: { userId: sourceUserId } });
      } else if (sourceWallet && !targetWallet) {
        await tx.walletAccount.update({ where: { userId: sourceUserId }, data: { userId: targetUserId } });
      }

      await tx.user.update({
        where: { id: targetUserId },
        data: {
          phone: phone || targetUser.phone,
          ...(targetUser.userType !== UserType.STAFF ? { name: nickname || targetUser.name || sourceUser.name } : {}),
          avatar: avatarUrl || targetUser.avatar || sourceUser.avatar,
          lastLoginAt: new Date(),
        },
      });

      await tx.user.delete({ where: { id: sourceUserId } });
    });

    return targetUserId;
  }
}
