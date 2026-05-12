import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import * as crypto from 'crypto';

const CHEST_ACTIVITY_KEY = 'treasure_box_demo';
const CHEST_TEST_CODE = 'CHEST8888';
const CHEST_TEST_CODE_ADD_KEYS = 10;
const CHEST_PROMO_TYPE = 'CHEST_PROMO';
const CHEST_PROMO_SOLD_OUT_TEXT = '来晚了，没抢到';

@Injectable()
export class ChestService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly defaultRewardItems = [
    { name: 'iPhone17 Pro Max', type: 'PHYSICAL', quantity: 1, weight: 1, stock: 1, sortOrder: 10, minDrawCount: 150, blockBeforeDays: 30, rampEveryDays: 7, rampStep: 1, rampMaxExtra: 20, publicRuleText: '奖励池包含常驻奖励与阶段奖励，阶段奖励将在满足条件后加入抽取范围；资格条件与参与区间将依据活动节奏动态更新，详细请关注活动说明。该活动一切解释权归蓝猫爽打所有。' },
    { name: 'iPhone17', type: 'PHYSICAL', quantity: 1, weight: 1, stock: 1, sortOrder: 20, minDrawCount: 150, blockBeforeDays: 30, rampEveryDays: 7, rampStep: 1, rampMaxExtra: 20, publicRuleText: '奖励池包含常驻奖励与阶段奖励，阶段奖励将在满足条件后加入抽取范围；资格条件与参与区间将依据活动节奏动态更新，详细请关注活动说明。该活动一切解释权归蓝猫爽打所有。' },
    { name: '2000元储值现金券', type: 'VOUCHER', quantity: 3, weight: 10, stock: 3, sortOrder: 30, minDrawCount: 150, blockBeforeDays: 30, rampEveryDays: 7, rampStep: 1, rampMaxExtra: 20, publicRuleText: '奖励池包含常驻奖励与阶段奖励，阶段奖励将在满足条件后加入抽取范围；资格条件与参与区间将依据活动节奏动态更新，详细请关注活动说明。该活动一切解释权归蓝猫爽打所有。' },
    { name: '1000元储值现金', type: 'VOUCHER', quantity: 6, weight: 10, stock: 6, sortOrder: 40, minDrawCount: 150, blockBeforeDays: 30, rampEveryDays: 7, rampStep: 1, rampMaxExtra: 20, publicRuleText: '奖励池包含常驻奖励与阶段奖励，阶段奖励将在满足条件后加入抽取范围；资格条件与参与区间将依据活动节奏动态更新，详细请关注活动说明。该活动一切解释权归蓝猫爽打所有。' },
    { name: '坠星者刀皮', type: 'GAME_ITEM', quantity: 6, weight: 10, stock: 6, sortOrder: 50, minDrawCount: 51, publicRuleText: '需累计抽奖>50次' },
    { name: '三角洲烽火通行证', type: 'GAME_ITEM', quantity: 20, weight: 100, stock: 20, sortOrder: 60, minDrawCount: 51, publicRuleText: '需累计抽奖>50次' },
    { name: '218体验单', type: 'DEDUCT_COUPON', quantity: 10, weight: 100, stock: 10, sortOrder: 70, minDrawCount: 51, publicRuleText: '需累计抽奖>50次' },
    { name: '128体验单', type: 'DEDUCT_COUPON', quantity: 20, weight: 100, stock: 20, sortOrder: 80, minDrawCount: 11, publicRuleText: '需累计抽奖>10次' },
    { name: '20元优惠券', type: 'COUPON', quantity: 300, weight: 120000, stock: 300, sortOrder: 90, publicRuleText: '常规奖池高概率奖项' },
    { name: '5元优惠券', type: 'COUPON', quantity: 500, weight: 180000, stock: 500, sortOrder: 100, publicRuleText: '常规奖池高概率奖项' },
    { name: '随机保底赠送', type: 'DEDUCT_COUPON', quantity: 1, weight: 699668, stock: null, sortOrder: 110, dynamicMode: 'WAN_50_500_PEAK_100_200', publicRuleText: '随机50-500万，高概率100-200万' },
  ];

  private async ensureConfig() {
    const found = await this.prisma.chestActivityConfig.findUnique({
      where: { activityKey: CHEST_ACTIVITY_KEY },
    });
    if (found) {
      await this.ensureDefaultRewardItems(found.activityKey);
      return found;
    }
    const created = await this.prisma.chestActivityConfig.create({
      data: {
        activityKey: CHEST_ACTIVITY_KEY,
        title: '开宝盒活动',
        enabled: false,
        defaultKeyCount: 1,
      },
    });
    await this.ensureDefaultRewardItems(created.activityKey);
    return created;
  }

  private async ensureDefaultRewardItems(activityKey: string) {
    const count = await this.prisma.chestRewardItem.count({ where: { activityKey } });
    if (count > 0) return;
    await this.prisma.chestRewardItem.createMany({
      data: this.defaultRewardItems.map((i) => ({ ...i, activityKey })),
    });
  }

  async getConfig() {
    return this.ensureConfig();
  }

  async updateConfig(body: { enabled?: boolean; title?: string; defaultKeyCount?: number }) {
    const base = await this.ensureConfig();
    const data: any = {};
    if (typeof body?.enabled === 'boolean') data.enabled = body.enabled;
    if (body?.enabled === true && !base.launchAt) data.launchAt = new Date();
    if (typeof body?.title === 'string' && body.title.trim()) data.title = body.title.trim();
    if (Number.isFinite(Number(body?.defaultKeyCount))) {
      data.defaultKeyCount = Math.max(1, Math.floor(Number(body.defaultKeyCount)));
    }
    return this.prisma.chestActivityConfig.update({
      where: { id: base.id },
      data,
    });
  }

  async listRewardItems() {
    const config = await this.ensureConfig();
    const list = await this.prisma.chestRewardItem.findMany({
      where: { activityKey: config.activityKey },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const totalWeight = list.filter((i) => i.enabled && (i.stock === null || i.stock > 0)).reduce((s, i) => s + Math.max(0, Number(i.weight || 0)), 0);
    return list.map((i) => ({
      ...i,
      probability:
        totalWeight > 0 && i.enabled && (i.stock === null || i.stock > 0)
          ? (Number(i.weight || 0) / totalWeight) * 100
          : 0,
      oddsText:
        totalWeight > 0 && i.enabled && (i.stock === null || i.stock > 0) && Number(i.weight || 0) > 0
          ? `1/${Math.max(1, Math.round(totalWeight / Number(i.weight || 1)))}`
          : '-',
    }));
  }

  async saveRewardItem(input: {
    id?: number;
    name: string;
    type: string;
    quantity?: number;
    weight?: number;
    stock?: number | null;
    enabled?: boolean;
    sortOrder?: number;
    minDrawCount?: number;
    blockBeforeDays?: number | null;
    rampEveryDays?: number | null;
    rampStep?: number | null;
    rampMaxExtra?: number | null;
    dynamicMode?: string | null;
    publicRuleText?: string;
  }) {
    const config = await this.ensureConfig();
    const data: any = {
      name: String(input?.name || '').trim().slice(0, 120),
      type: String(input?.type || '').trim().toUpperCase().slice(0, 32) || 'COUPON',
      quantity: Math.max(1, Math.floor(Number(input?.quantity || 1))),
      weight: Math.max(0, Math.floor(Number(input?.weight ?? 1))),
      stock:
        input?.stock === null || input?.stock === undefined || String(input.stock) === ''
          ? null
          : Math.max(0, Math.floor(Number(input.stock))),
      enabled: typeof input?.enabled === 'boolean' ? input.enabled : true,
      sortOrder: Math.max(0, Math.floor(Number(input?.sortOrder ?? 100))),
      minDrawCount: Math.max(0, Math.floor(Number(input?.minDrawCount ?? 0))),
      blockBeforeDays:
        input?.blockBeforeDays === null || input?.blockBeforeDays === undefined || String(input.blockBeforeDays) === ''
          ? null
          : Math.max(0, Math.floor(Number(input.blockBeforeDays))),
      rampEveryDays:
        input?.rampEveryDays === null || input?.rampEveryDays === undefined || String(input.rampEveryDays) === ''
          ? null
          : Math.max(1, Math.floor(Number(input.rampEveryDays))),
      rampStep:
        input?.rampStep === null || input?.rampStep === undefined || String(input.rampStep) === ''
          ? null
          : Math.max(1, Math.floor(Number(input.rampStep))),
      rampMaxExtra:
        input?.rampMaxExtra === null || input?.rampMaxExtra === undefined || String(input.rampMaxExtra) === ''
          ? null
          : Math.max(0, Math.floor(Number(input.rampMaxExtra))),
      dynamicMode: input?.dynamicMode ? String(input.dynamicMode).trim().slice(0, 64) : null,
      publicRuleText: input?.publicRuleText ? String(input.publicRuleText).trim().slice(0, 255) : null,
      activityKey: config.activityKey,
    };
    if (!data.name) throw new BadRequestException('奖品名称不能为空');

    const id = Number(input?.id || 0);
    if (id > 0) {
      return this.prisma.chestRewardItem.update({ where: { id }, data });
    }
    return this.prisma.chestRewardItem.create({ data });
  }

  async deleteRewardItem(idRaw: number) {
    const id = Math.max(1, Number(idRaw || 0));
    if (!id) throw new BadRequestException('奖品ID无效');
    return this.prisma.chestRewardItem.delete({ where: { id } });
  }

  private randomCode(prefix = 'BX', len = 10) {
    const pool = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = `${prefix}`.toUpperCase();
    for (let i = 0; i < len; i += 1) {
      s += pool[Math.floor(Math.random() * pool.length)];
    }
    return s;
  }

  private getDayBounds(now = new Date()) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  private normalizeExpireAt(expireAtRaw?: string | null) {
    if (expireAtRaw) {
      const d = new Date(expireAtRaw);
      if (Number.isNaN(d.getTime())) throw new BadRequestException('过期时间无效');
      d.setHours(23, 59, 59, 999);
      return d;
    }
    const { end } = this.getDayBounds();
    return end;
  }

  private distributeKeys(totalKeys: number, codeCount: number) {
    if (totalKeys < codeCount) throw new BadRequestException('总钥匙数不能小于抽奖码数量');
    const out = new Array(codeCount).fill(1);
    let left = totalKeys - codeCount;
    while (left > 0) {
      const idx = Math.floor(Math.random() * codeCount);
      out[idx] += 1;
      left -= 1;
    }
    return out;
  }

  private isPromoTableMissingError(error: any) {
    const msg = String(error?.message || '').toLowerCase();
    return msg.includes('chest_promo_bundles') || msg.includes('chest_promo_bundle_items') || msg.includes('does not exist');
  }

  private throwPromoTableMissing() {
    throw new BadRequestException('推广码功能未初始化，请先执行数据库迁移（创建 chest_promo_bundles / chest_promo_bundle_items）');
  }

  async generateCodes(params: { count: number; keyCount?: number; prefix?: string; expireAt?: string | null }, creatorId: number) {
    const count = Math.max(1, Math.min(500, Math.floor(Number(params?.count || 0))));
    const keyCount = Math.max(1, Math.min(999, Math.floor(Number(params?.keyCount || 1))));
    const prefix = String(params?.prefix || 'BX').trim().slice(0, 6).toUpperCase();
    const expireAt = params?.expireAt ? new Date(params.expireAt) : null;
    if (!count) throw new BadRequestException('count 必填');

    const created: any[] = [];
    let safe = 0;
    while (created.length < count && safe < count * 30) {
      safe += 1;
      const code = this.randomCode(prefix, 10);
      // eslint-disable-next-line no-await-in-loop
      const existed = await this.prisma.chestRedeemCode.findUnique({ where: { code }, select: { id: true } });
      if (existed) continue;
      // eslint-disable-next-line no-await-in-loop
      const row = await this.prisma.chestRedeemCode.create({
        data: {
          code,
          keyCount,
          createdBy: creatorId || null,
          expireAt,
        },
      });
      created.push(row);
    }
    return { count: created.length, keyCount, list: created };
  }

  async generatePromoBundle(
    params: { codeCount: number; totalKeys: number; prefix?: string; promoPrefix?: string; expireAt?: string | null },
    creatorId: number,
  ) {
    const codeCount = Math.max(1, Math.min(1000, Math.floor(Number(params?.codeCount || 0))));
    const totalKeys = Math.max(1, Math.min(200000, Math.floor(Number(params?.totalKeys || 0))));
    if (!codeCount) throw new BadRequestException('codeCount 必填');
    if (!totalKeys) throw new BadRequestException('totalKeys 必填');
    if (totalKeys < codeCount) throw new BadRequestException('总钥匙数不能小于抽奖码数量');

    const codePrefix = String(params?.prefix || 'BX').trim().slice(0, 6).toUpperCase();
    const promoPrefix = String(params?.promoPrefix || 'TG').trim().slice(0, 6).toUpperCase();
    const expireAt = this.normalizeExpireAt(params?.expireAt);
    const keyAllocation = this.distributeKeys(totalKeys, codeCount);

    try {
      return this.prisma.$transaction(async (tx) => {
      let promoCode = '';
      let safe = 0;
      while (!promoCode && safe < 80) {
        safe += 1;
        const tryCode = this.randomCode(promoPrefix, 10);
        // eslint-disable-next-line no-await-in-loop
        const existed = await tx.chestPromoBundle.findUnique({ where: { promoCode: tryCode }, select: { id: true } });
        if (!existed?.id) promoCode = tryCode;
      }
      if (!promoCode) throw new BadRequestException('推广码生成失败，请重试');

      const bundle = await tx.chestPromoBundle.create({
        data: {
          promoCode,
          promoType: CHEST_PROMO_TYPE,
          codeCount,
          totalKeys,
          expireAt,
          createdBy: creatorId || null,
        },
      });

      const itemList: any[] = [];
      let createdCodes = 0;
      let codeTry = 0;
      while (createdCodes < codeCount && codeTry < codeCount * 50) {
        codeTry += 1;
        const code = this.randomCode(codePrefix, 10);
        // eslint-disable-next-line no-await-in-loop
        const existed = await tx.chestRedeemCode.findUnique({ where: { code }, select: { id: true } });
        if (existed?.id) continue;
        // eslint-disable-next-line no-await-in-loop
        const redeemCode = await tx.chestRedeemCode.create({
          data: {
            code,
            keyCount: keyAllocation[createdCodes],
            createdBy: creatorId || null,
            expireAt,
          },
        });
        itemList.push({
          bundleId: bundle.id,
          redeemCodeId: redeemCode.id,
          redeemCode: redeemCode.code,
          keyCount: Number(redeemCode.keyCount || 1),
        });
        createdCodes += 1;
      }
      if (createdCodes !== codeCount) throw new BadRequestException('抽奖码生成失败，请重试');
      await tx.chestPromoBundleItem.createMany({ data: itemList });

        return {
          promoCode: bundle.promoCode,
          promoType: bundle.promoType,
          codeCount,
          totalKeys,
          expireAt: bundle.expireAt,
        };
      });
    } catch (e: any) {
      if (this.isPromoTableMissingError(e)) this.throwPromoTableMissing();
      throw e;
    }
  }

  async listPromoBundles(params: { page?: number; pageSize?: number; promoCode?: string }) {
    const page = Math.max(1, Number(params?.page || 1));
    const pageSize = Math.max(1, Math.min(100, Number(params?.pageSize || 20)));
    const skip = (page - 1) * pageSize;
    const promoCode = String(params?.promoCode || '').trim().toUpperCase();
    const where: any = {};
    if (promoCode) where.promoCode = { contains: promoCode };

    let total = 0;
    let list: any[] = [];
    try {
      [total, list] = await this.prisma.$transaction([
        this.prisma.chestPromoBundle.count({ where }),
        this.prisma.chestPromoBundle.findMany({
          where,
          orderBy: { id: 'desc' },
          skip,
          take: pageSize,
          include: { _count: { select: { items: true } } },
        }),
      ]);
    } catch (e: any) {
      if (this.isPromoTableMissingError(e)) this.throwPromoTableMissing();
      throw e;
    }
    const ids = list.map((i: any) => Number(i.id)).filter(Boolean);
    const assignedRows = ids.length
      ? await this.prisma.chestPromoBundleItem.groupBy({
        by: ['bundleId'],
        where: { bundleId: { in: ids }, assignedAt: { not: null } },
        _count: { _all: true },
      })
      : [];
    const assignedMap = new Map<number, number>(
      assignedRows.map((r: any) => [Number(r.bundleId), Number(r?._count?._all || 0)]),
    );
    const now = Date.now();
    const mapped = list.map((row: any) => {
      const assignedCount = Number(assignedMap.get(Number(row.id)) || 0);
      const leftCodes = Math.max(Number(row.codeCount || 0) - assignedCount, 0);
      return {
        id: row.id,
        promoCode: row.promoCode,
        promoType: row.promoType,
        codeCount: row.codeCount,
        totalKeys: row.totalKeys,
        assignedCount,
        leftCodes,
        active: row.active,
        expireAt: row.expireAt,
        isExpired: new Date(row.expireAt).getTime() < now,
        createdAt: row.createdAt,
      };
    });
    return { total, page, pageSize, list: mapped };
  }

  async listCodes(params: { page?: number; pageSize?: number; status?: 'UNUSED' | 'USED' | 'ALL'; code?: string; phone?: string }) {
    const page = Math.max(1, Number(params?.page || 1));
    const pageSize = Math.max(1, Math.min(100, Number(params?.pageSize || 20)));
    const skip = (page - 1) * pageSize;
    const status = params?.status || 'ALL';
    const where: any = {};
    if (status === 'UNUSED') where.redeemedAt = null;
    if (status === 'USED') where.redeemedAt = { not: null };
    const code = String(params?.code || '').trim().toUpperCase();
    if (code) where.code = { contains: code };
    const phone = String(params?.phone || '').trim();
    if (phone) where.redeemedUser = { phone: { contains: phone } };

    const [total, list] = await this.prisma.$transaction([
      this.prisma.chestRedeemCode.count({ where }),
      this.prisma.chestRedeemCode.findMany({
        where,
        orderBy: { id: 'desc' },
        skip,
        take: pageSize,
        include: { redeemedUser: { select: { id: true, name: true, phone: true } } },
      }),
    ]);

    const mapped = list.map((row: any) => {
      const usedKeys = Number(row?.redeemedCount || 0);
      const totalKeys = Number(row?.keyCount || 0);
      const remainingKeys = Math.max(totalKeys - usedKeys, 0);
      let usageStatus: 'UNUSED' | 'IN_USE' | 'USED' = 'UNUSED';
      if (usedKeys > 0) usageStatus = remainingKeys > 0 ? 'IN_USE' : 'USED';
      return {
        ...row,
        usedKeys,
        remainingKeys,
        usageStatus,
      };
    });

    return { total, page, pageSize, list: mapped };
  }

  async redeemCodeByAdmin(params: { code: string; userId?: number; phone?: string }) {
    const code = String(params?.code || '').trim().toUpperCase();
    if (!code) throw new BadRequestException('兑换码不能为空');
    let userId = Number(params?.userId || 0);
    if (!userId && params?.phone) {
      const user = await this.prisma.user.findUnique({
        where: { phone: String(params.phone).trim() },
        select: { id: true },
      });
      if (!user?.id) throw new BadRequestException('手机号对应用户不存在');
      userId = Number(user.id);
    }
    if (!userId) throw new BadRequestException('userId 或 phone 必填');
    const result: any = await this.redeemCode(userId, code);
    return { ...result, userId, code };
  }

  async getCodeOpenHistory(params: { code: string; page?: number; pageSize?: number }) {
    const code = String(params?.code || '').trim().toUpperCase();
    if (!code) throw new BadRequestException('兑换码不能为空');
    const redeemCode = await this.prisma.chestRedeemCode.findUnique({
      where: { code },
      select: { id: true, code: true },
    });
    if (!redeemCode?.id) return { total: 0, page: 1, pageSize: 20, list: [] };

    const page = Math.max(1, Number(params?.page || 1));
    const pageSize = Math.max(1, Math.min(200, Number(params?.pageSize || 20)));
    const skip = (page - 1) * pageSize;

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.chestOpenRecord.count({ where: { redeemCodeId: redeemCode.id } }),
      this.prisma.chestOpenRecord.findMany({
        where: { redeemCodeId: redeemCode.id },
        orderBy: { id: 'desc' },
        skip,
        take: pageSize,
        include: {
          user: { select: { id: true, name: true, phone: true } },
        },
      }),
    ]);

    const list = rows.flatMap((row: any) => {
      const rewards = Array.isArray(row?.rewardJson) ? row.rewardJson : [];
      if (!rewards.length) {
        return [{
          id: row.id,
          user: row.user,
          costKeys: row.costKeys,
          code: row.redeemCode || code,
          verifiedAt: row.verifiedAt || null,
          verifiedBy: row.verifiedBy || null,
          verifyRemark: row.verifyRemark || null,
          rewardName: '-',
          rewardType: '-',
          createdAt: row.createdAt,
        }];
      }
      return rewards.map((r: any) => ({
        id: row.id,
        user: row.user,
        costKeys: row.costKeys,
        code: row.redeemCode || code,
        verifiedAt: row.verifiedAt || null,
        verifiedBy: row.verifiedBy || null,
        verifyRemark: row.verifyRemark || null,
        rewardName: String(r?.name || '-'),
        rewardType: String(r?.type || '-'),
        createdAt: row.createdAt,
      }));
    });
    return { total, page, pageSize, list };
  }

  async verifyOpenRecord(params: { recordId: number; verified: boolean; remark?: string }, operatorId: number) {
    const recordId = Math.max(1, Number(params?.recordId || 0));
    if (!recordId) throw new BadRequestException('recordId 无效');
    const verified = Boolean(params?.verified);
    const remark = String(params?.remark || '').trim().slice(0, 255) || null;
    const existed = await this.prisma.chestOpenRecord.findUnique({
      where: { id: recordId },
      select: { id: true },
    });
    if (!existed?.id) throw new BadRequestException('抽奖记录不存在');
    const row = await this.prisma.chestOpenRecord.update({
      where: { id: recordId },
      data: verified
        ? { verifiedAt: new Date(), verifiedBy: Number(operatorId || 0) || null, verifyRemark: remark }
        : { verifiedAt: null, verifiedBy: null, verifyRemark: remark },
      select: { id: true, verifiedAt: true, verifiedBy: true, verifyRemark: true },
    });
    return row;
  }

  async myStatus(userId: number) {
    const config = await this.ensureConfig();
    const account = await this.prisma.chestUserAccount.findUnique({ where: { userId }, select: { keyCount: true } });
    return {
      enabled: config.enabled,
      title: config.title,
      keyCount: Number(account?.keyCount || 0),
    };
  }

  async redeemCode(userId: number, codeRaw: string) {
    const config = await this.ensureConfig();
    const code = String(codeRaw || '').trim().toUpperCase();
    if (!code) throw new BadRequestException('兑换码不能为空');

    // Demo 快捷测试码：不限次数，每次固定加钥匙
    if (code === CHEST_TEST_CODE) {
      const account = await this.prisma.chestUserAccount.upsert({
        where: { userId },
        create: { userId, keyCount: CHEST_TEST_CODE_ADD_KEYS },
        update: { keyCount: { increment: CHEST_TEST_CODE_ADD_KEYS } },
      });
      return { added: CHEST_TEST_CODE_ADD_KEYS, keyCount: Number(account.keyCount || 0), testCode: true };
    }

    if (!config.enabled) throw new BadRequestException('活动未开启');

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.chestRedeemCode.findUnique({ where: { code } });
      if (!row || !row.active) throw new BadRequestException('兑换码无效');
      if (row.expireAt && row.expireAt.getTime() < Date.now()) throw new BadRequestException('兑换码已过期');
      const keyCount = Number(row?.keyCount || 0);
      const redeemedCount = Number((row as any)?.redeemedCount || 0);
      if (redeemedCount >= keyCount) throw new BadRequestException('兑换码次数已用完');
      if (row.redeemedBy && Number(row.redeemedBy) !== Number(userId)) throw new BadRequestException('兑换码已绑定其他用户');

      await tx.chestRedeemCode.update({
        where: { id: row.id },
        data: {
          redeemedBy: row.redeemedBy || userId,
          redeemedAt: row.redeemedAt || new Date(),
          redeemedCount: { increment: 1 },
        } as any,
      });

      let account: any;
      try {
        account = await tx.chestUserAccount.upsert({
          where: { userId },
          create: { userId, keyCount: 1, lastRedeemCodeId: row.id },
          update: { keyCount: { increment: 1 }, lastRedeemCodeId: row.id },
        });
      } catch {
        // 兼容未执行新增迁移的库
        account = await tx.chestUserAccount.upsert({
          where: { userId },
          create: { userId, keyCount: 1 },
          update: { keyCount: { increment: 1 } },
        });
      }
      return { added: 1, keyCount: account.keyCount, remaining: Math.max(keyCount - redeemedCount - 1, 0) };
    });
  }

  async openChest(userId: number, costKeys?: number) {
    await this.ensureConfig();
    const consume = Math.max(1, Math.min(10, Math.floor(Number(costKeys || 1))));

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.chestUserAccount.findUnique({ where: { userId }, select: { keyCount: true } });
      const keyCount = Number(account?.keyCount || 0);
      if (keyCount < consume) throw new BadRequestException('钥匙不足');
      const redeemedCode = await tx.chestRedeemCode.findFirst({
        where: { redeemedBy: userId },
        orderBy: [{ redeemedAt: 'desc' }, { id: 'desc' }],
        select: { id: true, code: true },
      });

      const rewards: any[] = [];
      const pool = [
        { type: 'COUPON', name: '10元券', weight: 38 },
        { type: 'COUPON', name: '20元券', weight: 25 },
        { type: 'COUPON', name: '50元券', weight: 12 },
        { type: 'BONUS', name: '88积分', weight: 25 },
      ];

      const drawOne = () => {
        const total = pool.reduce((s, i) => s + i.weight, 0);
        let seed = Math.random() * total;
        for (const item of pool) {
          seed -= item.weight;
          if (seed <= 0) return item;
        }
        return pool[0];
      };

      for (let i = 0; i < consume; i += 1) rewards.push(drawOne());

      const updated = await tx.chestUserAccount.update({
        where: { userId },
        data: { keyCount: { decrement: consume } },
        select: { keyCount: true },
      });

      try {
        await tx.chestOpenRecord.create({
          data: {
            userId,
            costKeys: consume,
            redeemCodeId: redeemedCode?.id || null,
            redeemCode: redeemedCode?.code || null,
            rewardJson: rewards as any,
          },
        });
      } catch {
        // 兼容未执行新增迁移的库
        await tx.chestOpenRecord.create({
          data: {
            userId,
            costKeys: consume,
            rewardJson: rewards as any,
          },
        });
      }

      return { rewards, leftKeys: Number(updated.keyCount || 0) };
    });
  }

  private async tryRedeemFromCodes(userId: number, codes?: string[]) {
    if (!Array.isArray(codes) || !codes.length) return false;
    const uniq = Array.from(
      new Set(
        codes
          .map((c) => String(c || '').trim().toUpperCase())
          .filter(Boolean),
      ),
    );
    for (const code of uniq) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.redeemCode(userId, code);
        return true;
      } catch {
        // ignore invalid/used/expired and try next code
      }
    }
    return false;
  }

  async getOpenHistory(userId: number, page = 1, pageSize = 50) {
    const safePage = Math.max(1, Math.floor(Number(page || 1)));
    const safePageSize = Math.max(1, Math.min(200, Math.floor(Number(pageSize || 50))));
    const skip = (safePage - 1) * safePageSize;
    let total = 0;
    let rows: any[] = [];
    try {
      [total, rows] = await this.prisma.$transaction([
        this.prisma.chestOpenRecord.count({ where: { userId } }),
        this.prisma.chestOpenRecord.findMany({
          where: { userId },
          orderBy: { id: 'desc' },
          skip,
          take: safePageSize,
          select: {
            id: true,
            costKeys: true,
            redeemCodeId: true,
            redeemCode: true,
            rewardJson: true,
            createdAt: true,
          },
        }),
      ]);
    } catch {
      // 兼容未执行新增迁移的库
      [total, rows] = await this.prisma.$transaction([
        this.prisma.chestOpenRecord.count({ where: { userId } }),
        this.prisma.chestOpenRecord.findMany({
          where: { userId },
          orderBy: { id: 'desc' },
          skip,
          take: safePageSize,
          select: {
            id: true,
            costKeys: true,
            rewardJson: true,
            createdAt: true,
          },
        }),
      ]);
    }

    const list = rows.flatMap((row: any) => {
      const rewards = Array.isArray(row?.rewardJson) ? row.rewardJson : [];
      if (!rewards.length) {
        return [
          {
            id: row.id,
            name: '-',
            type: '-',
            costKeys: row.costKeys,
            redeemCode: row.redeemCode || null,
            redeemCodeId: row.redeemCodeId || null,
            createdAt: row.createdAt,
          },
        ];
      }
      return rewards.map((r: any) => ({
        id: row.id,
        name: String(r?.name || '-'),
        type: String(r?.type || '-'),
        costKeys: row.costKeys,
        redeemCode: row.redeemCode || null,
        redeemCodeId: row.redeemCodeId || null,
        createdAt: row.createdAt,
      }));
    });

    return { total, page: safePage, pageSize: safePageSize, list };
  }

  private guestPhoneByDevice(deviceId: string) {
    const hash = crypto.createHash('md5').update(String(deviceId || '')).digest('hex').slice(0, 12);
    return `guest_${hash}`;
  }

  private async ensureGuestUserByDevice(deviceIdRaw: string) {
    const deviceId = String(deviceIdRaw || '').trim();
    if (!deviceId) throw new BadRequestException('deviceId 不能为空');
    const phone = this.guestPhoneByDevice(deviceId);
    const existed = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
    if (existed?.id) return Number(existed.id);
    try {
      const created = await this.prisma.user.create({
        data: {
          phone,
          password: 'guest-no-login',
          name: `访客${phone.slice(-4)}`,
          userType: 'REGISTERED_USER' as any,
        },
        select: { id: true },
      });
      return Number(created.id);
    } catch (e: any) {
      const msg = String(e?.message || '').toLowerCase();
      const isPhoneUniqueConflict = msg.includes('users_phone_key') || msg.includes('unique constraint');
      if (!isPhoneUniqueConflict) throw e;
      const row = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
      if (row?.id) return Number(row.id);
      throw e;
    }
  }

  private async ensureUserByDeviceOrPhone(deviceId: string, phoneRaw?: string) {
    const normalizedPhone = String(phoneRaw || '').trim();
    if (normalizedPhone) {
      const phoneUser = await this.prisma.user.findUnique({
        where: { phone: normalizedPhone },
        select: { id: true },
      });
      if (phoneUser?.id) return Number(phoneUser.id);
      const created = await this.prisma.user.create({
        data: {
          phone: normalizedPhone,
          password: 'guest-no-login',
          name: `用户${normalizedPhone.slice(-4)}`,
          userType: 'REGISTERED_USER' as any,
        },
        select: { id: true },
      });
      return Number(created.id);
    }
    return this.ensureGuestUserByDevice(deviceId);
  }

  async publicRedeem(deviceId: string, code: string, phone?: string) {
    const userId = await this.ensureUserByDeviceOrPhone(deviceId, phone);
    return this.redeemCode(userId, code);
  }

  private async findCodeSnapshot(codeRaw: string) {
    const code = String(codeRaw || '').trim().toUpperCase();
    if (!code) throw new BadRequestException('兑换码不能为空');
    const row = await this.prisma.chestRedeemCode.findUnique({ where: { code } });
    if (!row || !row.active) throw new BadRequestException('兑换码无效');
    if (row.expireAt && row.expireAt.getTime() < Date.now()) throw new BadRequestException('兑换码已过期');
    const total = Number(row?.keyCount || 0);
    const used = Number((row as any)?.redeemedCount || 0);
    const remaining = Math.max(total - used, 0);
    return { row, code, total, used, remaining };
  }

  private randomGuaranteeWan() {
    const r = Math.random();
    if (r < 0.75) return 100 + Math.floor(Math.random() * 101);
    if (r < 0.93) return 50 + Math.floor(Math.random() * 50);
    return 201 + Math.floor(Math.random() * 300);
  }

  private isItemEligible(item: any, launchAt: Date | null, drawCount: number) {
    const baseMin = Number(item?.minDrawCount || 0);
    const blockBeforeDays = item?.blockBeforeDays === null || item?.blockBeforeDays === undefined ? null : Number(item.blockBeforeDays);
    const rampEveryDays = item?.rampEveryDays === null || item?.rampEveryDays === undefined ? null : Number(item.rampEveryDays);
    const rampStep = item?.rampStep === null || item?.rampStep === undefined ? null : Number(item.rampStep);
    const rampMaxExtra = item?.rampMaxExtra === null || item?.rampMaxExtra === undefined ? null : Number(item.rampMaxExtra);
    if (launchAt && blockBeforeDays !== null) {
      const days = Math.floor((Date.now() - new Date(launchAt).getTime()) / 86400000);
      if (days < blockBeforeDays) return false;
      let effectiveMin = baseMin;
      if (rampEveryDays && rampStep) {
        const passedDays = Math.max(0, days - blockBeforeDays);
        const rampTimes = Math.floor(passedDays / rampEveryDays);
        const extra = rampTimes * rampStep;
        effectiveMin += rampMaxExtra !== null ? Math.min(extra, rampMaxExtra) : extra;
      }
      if (drawCount < effectiveMin) return false;
      return true;
    }
    if (drawCount < baseMin) return false;
    return true;
  }

  private async drawRewardsFromDb(tx: any, consume: number, drawCountBefore: number) {
    const cfg = await tx.chestActivityConfig.findUnique({
      where: { activityKey: CHEST_ACTIVITY_KEY },
      select: { launchAt: true, createdAt: true },
    });
    const items: any[] = await tx.chestRewardItem.findMany({
      where: { activityKey: CHEST_ACTIVITY_KEY, enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    const available = items.filter((i) =>
      Number(i.weight || 0) > 0
      && (i.stock === null || Number(i.stock) > 0)
      && this.isItemEligible(i, (cfg?.launchAt || cfg?.createdAt) || null, drawCountBefore),
    );
    if (!available.length) throw new BadRequestException('奖池未配置可用奖品');

    const rewards: any[] = [];
    for (let i = 0; i < consume; i += 1) {
      const totalWeight = available.reduce((s, it) => s + Number(it.weight || 0), 0);
      if (totalWeight <= 0) throw new BadRequestException('奖池权重配置无效');
      let seed = Math.random() * totalWeight;
      let picked = available[0];
      for (const it of available) {
        seed -= Number(it.weight || 0);
        if (seed <= 0) {
          picked = it;
          break;
        }
      }
      if (picked.stock !== null) {
        const updated = await tx.chestRewardItem.updateMany({
          where: { id: picked.id, stock: { gte: 1 } },
          data: { stock: { decrement: 1 } },
        });
        if (!updated.count) {
          const idx = available.findIndex((x) => x.id === picked.id);
          if (idx >= 0) available.splice(idx, 1);
          i -= 1;
          if (!available.length) throw new BadRequestException('奖池库存不足');
          continue;
        }
        const idx = available.findIndex((x) => x.id === picked.id);
        if (idx >= 0) {
          const left = Number(available[idx].stock || 0) - 1;
          available[idx].stock = left;
          if (left <= 0) available.splice(idx, 1);
        }
      }
      let outQuantity = Number(picked.quantity || 1);
      let outName = String(picked.name || '-');
      if (String(picked.dynamicMode || '') === 'WAN_50_500_PEAK_100_200') {
        outQuantity = this.randomGuaranteeWan();
        outName = `${picked.name}${outQuantity}万`;
      }
      rewards.push({
        itemId: picked.id,
        type: picked.type,
        name: outName,
        quantity: outQuantity,
      });
    }
    return rewards;
  }

  async publicStatus(deviceId: string, phone?: string, codeRaw?: string) {
    const config = await this.ensureConfig();
    await this.ensureUserByDeviceOrPhone(deviceId, phone);
    const code = String(codeRaw || '').trim().toUpperCase();
    if (!code) {
      return { enabled: config.enabled, title: config.title, keyCount: 0, code: null, remaining: 0 };
    }
    try {
      const snap = await this.findCodeSnapshot(code);
      return { enabled: config.enabled, title: config.title, keyCount: snap.remaining, code, remaining: snap.remaining };
    } catch {
      return { enabled: config.enabled, title: config.title, keyCount: 0, code, remaining: 0 };
    }
  }

  async publicOpen(deviceId: string, costKeys?: number, phone?: string, codeRaw?: string) {
    const config = await this.ensureConfig();
    if (!config.enabled) throw new BadRequestException('活动未开启');
    const userId = await this.ensureUserByDeviceOrPhone(deviceId, phone);
    const consume = Math.max(1, Math.min(10, Math.floor(Number(costKeys || 1))));
    const code = String(codeRaw || '').trim().toUpperCase();
    if (!code) throw new BadRequestException('请先提供兑换码');

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.chestRedeemCode.findUnique({ where: { code } });
      if (!row || !row.active) throw new BadRequestException('兑换码无效');
      if (row.expireAt && row.expireAt.getTime() < Date.now()) throw new BadRequestException('兑换码已过期');
      const total = Number(row?.keyCount || 0);
      const used = Number((row as any)?.redeemedCount || 0);
      const remaining = Math.max(total - used, 0);
      if (remaining < consume) throw new BadRequestException('钥匙不足');

      const stat = await tx.chestOpenRecord.aggregate({
        where: { userId },
        _sum: { costKeys: true },
      });
      const drawCountBefore = Number(stat?._sum?.costKeys || 0);
      const rewards = await this.drawRewardsFromDb(tx, consume, drawCountBefore);
      await tx.chestRedeemCode.update({
        where: { id: row.id },
        data: {
          redeemedBy: row.redeemedBy || userId,
          redeemedAt: row.redeemedAt || new Date(),
          redeemedCount: { increment: consume },
        } as any,
      });

      try {
        await tx.chestOpenRecord.create({
          data: {
            userId,
            costKeys: consume,
            redeemCodeId: row.id,
            redeemCode: row.code,
            rewardJson: rewards as any,
          },
        });
      } catch {
        await tx.chestOpenRecord.create({
          data: {
            userId,
            costKeys: consume,
            rewardJson: rewards as any,
          },
        });
      }

      return { rewards, leftKeys: remaining - consume, code: row.code };
    });
  }

  async publicHistory(deviceId: string, page?: number, pageSize?: number, phone?: string, codeRaw?: string) {
    await this.ensureUserByDeviceOrPhone(deviceId, phone);
    const code = String(codeRaw || '').trim().toUpperCase();
    if (!code) return { total: 0, page: 1, pageSize: 20, list: [] };
    return this.getCodeOpenHistory({ code, page, pageSize });
  }

  async publicRewardPool() {
    const config = await this.ensureConfig();
    const list = await this.listRewardItems();
    return {
      enabled: config.enabled,
      title: config.title,
      list: list.map((i: any) => ({
        id: i.id,
        name: i.name,
        type: i.type,
        quantity: i.quantity,
        probability: i.probability,
        stock: i.stock,
        enabled: i.enabled,
        publicRuleText: i.publicRuleText || '',
        minDrawCount: i.minDrawCount || 0,
        blockBeforeDays: i.blockBeforeDays ?? null,
        rampEveryDays: i.rampEveryDays ?? null,
        rampStep: i.rampStep ?? null,
        rampMaxExtra: i.rampMaxExtra ?? null,
      })),
    };
  }

  async publicPromoStatus(deviceId: string, promoCodeRaw: string, phone?: string) {
    const promoCode = String(promoCodeRaw || '').trim().toUpperCase();
    if (!promoCode) throw new BadRequestException('推广码不能为空');
    await this.ensureUserByDeviceOrPhone(deviceId, phone);
    let bundle: any = null;
    try {
      bundle = await this.prisma.chestPromoBundle.findUnique({
        where: { promoCode },
        select: { id: true, promoCode: true, active: true, expireAt: true, codeCount: true },
      });
    } catch (e: any) {
      if (this.isPromoTableMissingError(e)) this.throwPromoTableMissing();
      throw e;
    }
    if (!bundle?.id) return { promoCode, status: 'SOLD_OUT', message: CHEST_PROMO_SOLD_OUT_TEXT, leftCodes: 0 };
    const now = Date.now();
    if (!bundle.active || new Date(bundle.expireAt).getTime() < now) {
      return { promoCode, status: 'SOLD_OUT', message: CHEST_PROMO_SOLD_OUT_TEXT, leftCodes: 0 };
    }
    const assignedCount = await this.prisma.chestPromoBundleItem.count({
      where: { bundleId: bundle.id, assignedAt: { not: null } },
    });
    const leftCodes = Math.max(Number(bundle.codeCount || 0) - assignedCount, 0);
    if (leftCodes <= 0) return { promoCode, status: 'SOLD_OUT', message: CHEST_PROMO_SOLD_OUT_TEXT, leftCodes: 0 };
    return { promoCode, status: 'AVAILABLE', message: 'ok', leftCodes };
  }

  async publicPromoClaim(deviceId: string, promoCodeRaw: string, phone?: string) {
    const promoCode = String(promoCodeRaw || '').trim().toUpperCase();
    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedDeviceId) throw new BadRequestException('deviceId 不能为空');
    if (!promoCode) throw new BadRequestException('推广码不能为空');
    const userId = await this.ensureUserByDeviceOrPhone(normalizedDeviceId, phone);

    try {
      return this.prisma.$transaction(async (tx) => {
      const bundle = await tx.chestPromoBundle.findUnique({
        where: { promoCode },
        select: { id: true, promoCode: true, promoType: true, active: true, expireAt: true },
      });
      if (!bundle?.id) throw new BadRequestException(CHEST_PROMO_SOLD_OUT_TEXT);
      if (!bundle.active || new Date(bundle.expireAt).getTime() < Date.now()) {
        throw new BadRequestException(CHEST_PROMO_SOLD_OUT_TEXT);
      }

      const alreadyInBundle = await tx.chestPromoBundleItem.findFirst({
        where: {
          bundleId: bundle.id,
          assignedAt: { not: null },
          OR: [{ assignedUserId: userId }, { assignedDeviceId: normalizedDeviceId }],
        },
        select: { id: true, redeemCode: true, keyCount: true },
      });
      if (alreadyInBundle?.id) {
        return {
          promoCode: bundle.promoCode,
          redeemCode: alreadyInBundle.redeemCode,
          keyCount: alreadyInBundle.keyCount,
          message: 'ok',
        };
      }

      const { start, end } = this.getDayBounds();
      const sameDayClaim = await tx.chestPromoBundleItem.findFirst({
        where: {
          assignedAt: { gte: start, lte: end },
          bundle: { promoType: bundle.promoType },
          OR: [{ assignedUserId: userId }, { assignedDeviceId: normalizedDeviceId }],
        },
        select: { id: true },
      });
      if (sameDayClaim?.id) throw new BadRequestException(CHEST_PROMO_SOLD_OUT_TEXT);

      let assigned: any = null;
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const row = await tx.chestPromoBundleItem.findFirst({
          where: { bundleId: bundle.id, assignedAt: null },
          orderBy: { id: 'asc' },
          select: { id: true, redeemCode: true, keyCount: true },
        });
        if (!row?.id) break;
        // eslint-disable-next-line no-await-in-loop
        const updated = await tx.chestPromoBundleItem.updateMany({
          where: { id: row.id, assignedAt: null },
          data: { assignedAt: new Date(), assignedUserId: userId, assignedDeviceId: normalizedDeviceId },
        });
        if (updated.count > 0) {
          assigned = row;
          break;
        }
      }
      if (!assigned?.id) throw new BadRequestException(CHEST_PROMO_SOLD_OUT_TEXT);

        return {
          promoCode: bundle.promoCode,
          redeemCode: assigned.redeemCode,
          keyCount: assigned.keyCount,
          message: 'ok',
        };
      });
    } catch (e: any) {
      if (this.isPromoTableMissingError(e)) this.throwPromoTableMissing();
      throw e;
    }
  }
}
