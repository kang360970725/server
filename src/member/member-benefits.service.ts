import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const money = (value: unknown) => Math.round(Number(value || 0) * 100) / 100;
const quantity = (value: unknown) => Math.round(Number(value || 0) * 100) / 100;

@Injectable()
export class MemberBenefitsService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeBenefit(data: any) {
    const code = String(data?.code || '').trim().toUpperCase();
    const name = String(data?.name || '').trim();
    if (!code) throw new BadRequestException('权益编码不能为空');
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) throw new BadRequestException('权益编码仅支持大写字母、数字和下划线');
    if (!name) throw new BadRequestException('权益名称不能为空');
    return {
      code,
      name: name.slice(0, 120),
      description: data?.description ? String(data.description).trim() : null,
      category: String(data?.category || 'SERVICE').trim().toUpperCase().slice(0, 32),
      unitName: String(data?.unitName || '次').trim().slice(0, 24) || '次',
      unitValue: money(data?.unitValue),
      refundableDeduction: !!data?.refundableDeduction,
      reviewRestricted: !!data?.reviewRestricted,
      requiresVerification: data?.requiresVerification !== false,
      enabled: data?.enabled !== false,
      sortOrder: Math.floor(Number(data?.sortOrder ?? 100)),
    };
  }

  async listBenefits(input: { enabledOnly?: boolean; reviewMode?: boolean } = {}) {
    const rows = await (this.prisma as any).memberBenefit.findMany({
      where: {
        ...(input.enabledOnly ? { enabled: true } : {}),
        ...(input.reviewMode ? { reviewRestricted: false } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row: any) => ({ ...row, unitValue: money(row.unitValue) }));
  }

  async createBenefit(data: any) {
    const normalized = this.normalizeBenefit(data);
    const exists = await (this.prisma as any).memberBenefit.findUnique({ where: { code: normalized.code } });
    if (exists) throw new BadRequestException('权益编码已存在');
    return (this.prisma as any).memberBenefit.create({ data: normalized });
  }

  async updateBenefit(id: number, data: any) {
    const current = await (this.prisma as any).memberBenefit.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('会员权益不存在');
    const normalized = this.normalizeBenefit({ ...current, ...data });
    return (this.prisma as any).memberBenefit.update({ where: { id }, data: normalized });
  }

  async deleteBenefit(id: number) {
    const current = await (this.prisma as any).memberBenefit.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('会员权益不存在');
    const [levelCount, grantCount] = await Promise.all([
      (this.prisma as any).memberLevelBenefit.count({ where: { benefitId: id } }),
      (this.prisma as any).memberBenefitGrant.count({ where: { benefitId: id } }),
    ]);
    if (levelCount || grantCount) throw new BadRequestException('权益已有等级关联或发放记录，请停用而不是删除');
    await (this.prisma as any).memberBenefit.delete({ where: { id } });
    return { success: true, id };
  }

  async listLevelBenefits(options: { reviewMode?: boolean; enabledOnly?: boolean } = {}) {
    const levels = await (this.prisma as any).memberLevelConfig.findMany({
      where: options.enabledOnly ? { enabled: true } : undefined,
      include: {
        levelBenefits: {
          where: {
            enabled: true,
            ...(options.reviewMode ? { benefit: { reviewRestricted: false } } : {}),
          },
          include: { benefit: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return levels.map((level: any) => ({
      ...level,
      minRechargeAmount: money(level.minRechargeAmount),
      benefits: level.levelBenefits.map((item: any) => ({
        id: item.benefit.id,
        code: item.benefit.code,
        name: item.benefit.name,
        description: item.benefit.description,
        category: item.benefit.category,
        unitName: item.benefit.unitName,
        unitValue: money(item.benefit.unitValue),
        reviewRestricted: item.benefit.reviewRestricted,
        requiresVerification: item.benefit.requiresVerification,
        grantMode: item.grantMode,
        quantity: item.quantity == null ? null : quantity(item.quantity),
        unlimited: item.unlimited,
        validityDays: item.validityDays,
        config: item.config,
        sortOrder: item.sortOrder,
      })),
    }));
  }

  async replaceLevelBenefits(levelId: number, rows: any[]) {
    const level = await (this.prisma as any).memberLevelConfig.findUnique({ where: { id: levelId } });
    if (!level) throw new NotFoundException('会员等级不存在');
    const normalized = (Array.isArray(rows) ? rows : []).map((row: any, index: number) => {
      const benefitId = Number(row?.benefitId);
      if (!benefitId) throw new BadRequestException(`第${index + 1}项权益无效`);
      const grantMode = String(row?.grantMode || 'IDENTITY').trim().toUpperCase();
      if (!['IDENTITY', 'MONTHLY', 'UPGRADE_ONCE', 'AUTOMATIC_DISCOUNT'].includes(grantMode)) {
        throw new BadRequestException(`第${index + 1}项发放方式无效`);
      }
      const unlimited = !!row?.unlimited;
      const value = row?.quantity == null || row?.quantity === '' ? null : quantity(row.quantity);
      if (!unlimited && !['IDENTITY', 'AUTOMATIC_DISCOUNT'].includes(grantMode) && (!(Number(value) > 0))) {
        throw new BadRequestException(`第${index + 1}项权益数量必须大于0`);
      }
      return {
        levelId,
        benefitId,
        grantMode,
        quantity: unlimited ? null : value,
        unlimited,
        validityDays: row?.validityDays == null || row?.validityDays === '' ? null : Math.max(1, Math.floor(Number(row.validityDays))),
        config: row?.config && typeof row.config === 'object' ? row.config : undefined,
        enabled: row?.enabled !== false,
        sortOrder: Math.floor(Number(row?.sortOrder ?? (index + 1) * 10)),
      };
    });
    if (new Set(normalized.map((row: any) => row.benefitId)).size !== normalized.length) {
      throw new BadRequestException('同一等级不能重复关联同一权益');
    }
    if (normalized.length) {
      const count = await (this.prisma as any).memberBenefit.count({ where: { id: { in: normalized.map((row: any) => row.benefitId) } } });
      if (count !== normalized.length) throw new BadRequestException('存在无效的会员权益');
    }
    await this.prisma.$transaction(async (tx: any) => {
      await tx.memberLevelBenefit.deleteMany({ where: { levelId } });
      if (normalized.length) await tx.memberLevelBenefit.createMany({ data: normalized });
    });
    return this.listLevelBenefits();
  }

  private monthRange(now = new Date()) {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
    };
  }

  async grantForLevelChange(params: {
    tx: any;
    userId: number;
    beforeLevelCode: string;
    afterLevelCode: string;
    sourceType: string;
    sourceId?: number;
  }) {
    const { tx, userId, beforeLevelCode, afterLevelCode, sourceType, sourceId } = params;
    if (!afterLevelCode || beforeLevelCode === afterLevelCode) return [];
    const levels = await tx.memberLevelConfig.findMany({
      where: { code: { in: [beforeLevelCode, afterLevelCode] } },
      select: { id: true, code: true, sortOrder: true },
    });
    const before = levels.find((item: any) => item.code === beforeLevelCode);
    const after = levels.find((item: any) => item.code === afterLevelCode);
    if (!after || (before && Number(after.sortOrder) <= Number(before.sortOrder))) return [];

    const configs = await tx.memberLevelBenefit.findMany({
      where: { levelId: after.id, enabled: true, grantMode: { in: ['UPGRADE_ONCE', 'MONTHLY'] } },
      include: { benefit: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const created: any[] = [];
    for (const config of configs) {
      if (!config.benefit?.enabled) continue;
      const existing = config.grantMode === 'UPGRADE_ONCE'
        ? await tx.memberBenefitGrant.findFirst({
            where: { userId, benefitId: config.benefitId, levelCodeSnapshot: afterLevelCode, sourceType: 'LEVEL_UPGRADE' },
          })
        : null;
      if (existing) continue;
      const range = config.grantMode === 'MONTHLY' ? this.monthRange() : null;
      const expiresAt = config.validityDays
        ? new Date(Date.now() + Number(config.validityDays) * 86400000)
        : range?.end || null;
      created.push(await tx.memberBenefitGrant.create({
        data: {
          userId,
          benefitId: config.benefitId,
          levelCodeSnapshot: afterLevelCode,
          benefitNameSnapshot: config.benefit.name,
          unitNameSnapshot: config.benefit.unitName,
          unitValueSnapshot: config.benefit.unitValue,
          sourceType: config.grantMode === 'UPGRADE_ONCE' ? 'LEVEL_UPGRADE' : sourceType,
          sourceId: sourceId ?? null,
          totalQuantity: config.unlimited ? null : config.quantity,
          unlimited: config.unlimited,
          periodStart: range?.start || null,
          periodEnd: range?.end || null,
          expiresAt,
        },
      }));
    }
    return created;
  }

  async reissueForManualLevelChange(params: {
    tx: any;
    userId: number;
    afterLevelCode: string;
    sourceId?: number;
  }) {
    const { tx, userId, afterLevelCode, sourceId } = params;
    const level = await tx.memberLevelConfig.findUnique({
      where: { code: afterLevelCode },
      select: { id: true, code: true },
    });
    if (!level) throw new NotFoundException('目标会员等级不存在');

    // 保留旧发放和核销台账供审计，但不再计入会员当前可用权益。
    await tx.memberBenefitGrant.updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'REPLACED' },
    });

    const configs = await tx.memberLevelBenefit.findMany({
      where: {
        levelId: level.id,
        enabled: true,
        grantMode: { in: ['UPGRADE_ONCE', 'MONTHLY'] },
        benefit: { enabled: true },
      },
      include: { benefit: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const created: any[] = [];
    const now = new Date();
    for (const config of configs) {
      const range = config.grantMode === 'MONTHLY' ? this.monthRange(now) : null;
      const expiresAt = config.validityDays
        ? new Date(now.getTime() + Number(config.validityDays) * 86400000)
        : range?.end || null;
      created.push(await tx.memberBenefitGrant.create({
        data: {
          userId,
          benefitId: config.benefitId,
          levelCodeSnapshot: afterLevelCode,
          benefitNameSnapshot: config.benefit.name,
          unitNameSnapshot: config.benefit.unitName,
          unitValueSnapshot: config.benefit.unitValue,
          sourceType: 'ADMIN_LEVEL_RESET',
          sourceId: sourceId ?? null,
          totalQuantity: config.unlimited ? null : config.quantity,
          usedQuantity: 0,
          unlimited: config.unlimited,
          periodStart: range?.start || null,
          periodEnd: range?.end || null,
          expiresAt,
        },
      }));
    }
    return created;
  }

  async ensureMonthlyGrants(userId: number) {
    const profile = await (this.prisma as any).memberProfile.findUnique({ where: { userId } });
    if (!profile) return;
    const level = await (this.prisma as any).memberLevelConfig.findUnique({ where: { code: profile.levelCode } });
    if (!level) return;
    const range = this.monthRange();
    const configs = await (this.prisma as any).memberLevelBenefit.findMany({
      where: { levelId: level.id, enabled: true, grantMode: 'MONTHLY', benefit: { enabled: true } },
      include: { benefit: true },
    });
    await this.prisma.$transaction(async (tx: any) => {
      for (const config of configs) {
        const exists = await tx.memberBenefitGrant.findFirst({
          where: { userId, benefitId: config.benefitId, levelCodeSnapshot: level.code, periodStart: range.start },
        });
        if (exists) continue;
        await tx.memberBenefitGrant.create({ data: {
          userId,
          benefitId: config.benefitId,
          levelCodeSnapshot: level.code,
          benefitNameSnapshot: config.benefit.name,
          unitNameSnapshot: config.benefit.unitName,
          unitValueSnapshot: config.benefit.unitValue,
          sourceType: 'MONTHLY_LEVEL',
          totalQuantity: config.unlimited ? null : config.quantity,
          unlimited: config.unlimited,
          periodStart: range.start,
          periodEnd: range.end,
          expiresAt: range.end,
        }});
      }
    });
  }

  async listUserBenefits(userId: number, options: { reviewMode?: boolean; includeHistory?: boolean } = {}) {
    await this.ensureMonthlyGrants(userId);
    const now = new Date();
    const rows = await (this.prisma as any).memberBenefitGrant.findMany({
      where: {
        userId,
        ...(options.includeHistory ? {} : { status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }),
        ...(options.reviewMode ? { benefit: { reviewRestricted: false } } : {}),
      },
      include: { benefit: true, usages: { orderBy: { usedAt: 'desc' } } },
      orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }],
    });
    const operatorIds = [...new Set(rows.flatMap((row: any) => row.usages || []).map((item: any) => Number(item.operatorId)).filter(Boolean))] as number[];
    const operators = operatorIds.length ? await this.prisma.user.findMany({
      where: { id: { in: operatorIds } },
      select: { id: true, name: true, realName: true },
    }) : [];
    const operatorNames = new Map(operators.map((item: any) => [item.id, item.realName || item.name || `#${item.id}`]));
    return rows.map((row: any) => ({
      ...row,
      totalQuantity: row.totalQuantity == null ? null : quantity(row.totalQuantity),
      usedQuantity: quantity(row.usedQuantity),
      remainingQuantity: row.unlimited ? null : Math.max(0, quantity(row.totalQuantity) - quantity(row.usedQuantity)),
      unitValueSnapshot: money(row.unitValueSnapshot),
      usages: (row.usages || []).map((item: any) => ({
        ...item,
        quantity: quantity(item.quantity),
        deductedValue: money(item.deductedValue),
        operatorName: item.operatorId ? (operatorNames.get(item.operatorId) || `#${item.operatorId}`) : '系统',
      })),
    }));
  }

  async listUsageRecords(input: any = {}) {
    const page = Math.max(1, Math.floor(Number(input?.page || input?.current || 1)));
    const limit = Math.min(200, Math.max(1, Math.floor(Number(input?.limit || input?.pageSize || 20))));
    const keyword = String(input?.keyword || '').trim();
    const userId = Number(input?.userId || 0);
    const benefitId = Number(input?.benefitId || 0);
    const startAt = input?.startAt ? new Date(input.startAt) : null;
    const endAt = input?.endAt ? new Date(input.endAt) : null;
    const where: any = {
      ...(userId > 0 ? { userId } : {}),
      ...(benefitId > 0 ? { grant: { benefitId } } : {}),
      ...(input?.status ? { status: String(input.status) } : {}),
      ...(startAt || endAt ? { usedAt: { ...(startAt ? { gte: startAt } : {}), ...(endAt ? { lte: endAt } : {}) } } : {}),
      ...(keyword ? {
        OR: [
          { user: { name: { contains: keyword } } },
          { user: { realName: { contains: keyword } } },
          { user: { phone: { contains: keyword } } },
          { user: { memberProfile: { is: { memberCode: { contains: keyword } } } } },
          { grant: { benefitNameSnapshot: { contains: keyword } } },
          { remark: { contains: keyword } },
        ],
      } : {}),
    };
    const [total, rows] = await Promise.all([
      (this.prisma as any).memberBenefitUsage.count({ where }),
      (this.prisma as any).memberBenefitUsage.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, realName: true, phone: true, memberProfile: { select: { memberCode: true } } } },
          grant: { select: { id: true, benefitId: true, benefitNameSnapshot: true, unitNameSnapshot: true, levelCodeSnapshot: true } },
        },
        orderBy: [{ usedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const operatorIds = [...new Set(rows.map((item: any) => Number(item.operatorId)).filter(Boolean))] as number[];
    const operators = operatorIds.length ? await this.prisma.user.findMany({
      where: { id: { in: operatorIds } }, select: { id: true, name: true, realName: true },
    }) : [];
    const operatorNames = new Map(operators.map((item: any) => [item.id, item.realName || item.name || `#${item.id}`]));
    return {
      data: rows.map((item: any) => ({
        ...item,
        quantity: quantity(item.quantity),
        deductedValue: money(item.deductedValue),
        operatorName: item.operatorId ? (operatorNames.get(item.operatorId) || `#${item.operatorId}`) : '系统',
      })),
      total,
      page,
      limit,
    };
  }

  async useBenefit(grantId: number, input: any, operatorId?: number) {
    const useQuantity = quantity(input?.quantity || 1);
    if (!(useQuantity > 0)) throw new BadRequestException('核销数量必须大于0');
    return this.prisma.$transaction(async (tx: any) => {
      const grant = await tx.memberBenefitGrant.findUnique({ where: { id: grantId }, include: { benefit: true } });
      if (!grant) throw new NotFoundException('会员权益不存在');
      if (grant.status !== 'ACTIVE') throw new BadRequestException('该权益当前不可核销');
      if (grant.expiresAt && new Date(grant.expiresAt) <= new Date()) throw new BadRequestException('该权益已过期');
      if (!grant.unlimited && quantity(grant.usedQuantity) + useQuantity > quantity(grant.totalQuantity)) {
        throw new BadRequestException('权益剩余数量不足');
      }
      const deductedValue = grant.benefit?.refundableDeduction ? money(useQuantity * money(grant.unitValueSnapshot)) : 0;
      const usage = await tx.memberBenefitUsage.create({ data: {
        grantId,
        userId: grant.userId,
        quantity: useQuantity,
        deductedValue,
        sourceType: input?.sourceType ? String(input.sourceType).slice(0, 32) : null,
        sourceId: input?.sourceId ? Number(input.sourceId) : null,
        operatorId: operatorId || null,
        remark: input?.remark ? String(input.remark).slice(0, 255) : null,
      }});
      await tx.memberBenefitGrant.update({
        where: { id: grantId },
        data: { usedQuantity: { increment: new Prisma.Decimal(useQuantity) } },
      });
      return usage;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
