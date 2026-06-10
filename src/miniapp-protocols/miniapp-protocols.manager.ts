import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { MiniappProtocol, MiniappProtocolCategory, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';
import {
  MINIAPP_PROTOCOL_KEYS,
  MiniappProtocolKey,
  UpsertMiniappProtocolDto,
} from './dto/upsert-miniapp-protocol.dto';
import { UpsertMiniappProtocolCategoryDto } from './dto/upsert-miniapp-protocol-category.dto';

export type MiniappProtocolCategoryItem = {
  id: number;
  name: string;
  description?: string;
  sort: number;
  enabled: boolean;
  protocolCount?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type MiniappProtocolItem = {
  id: number;
  categoryId: number;
  category?: {
    id: number;
    name: string;
    description?: string;
    sort: number;
    enabled: boolean;
  } | null;
  key: string;
  title: string;
  coverImage?: string;
  content: string;
  enabled: boolean;
  remark?: string;
  sort: number;
  createdAt?: string;
  updatedAt?: string;
};

type ProtocolSeed = {
  key: MiniappProtocolKey;
  title: string;
  categoryName: string;
  coverImage?: string;
  content: string;
  enabled: boolean;
  remark?: string;
  sort: number;
};

const DEFAULT_CATEGORIES = [
  {
    name: 'C 端用户协议（用户勾选）',
    description: '用户在小程序端勾选确认的协议',
    sort: 10,
  },
  {
    name: 'C 端客户权益',
    description: '菜单 Banner、权益说明及客户须知',
    sort: 15,
  },
  {
    name: 'B 端商户协议（商家入驻签约）',
    description: '商家入驻、结算、保证金及发布规范',
    sort: 20,
  },
  {
    name: '平台对外合作协议（平台和第三方公司签）',
    description: '平台与第三方合作、支付、分账和签章协议',
    sort: 30,
  },
  {
    name: '营销活动合作协议',
    description: '优惠券、拼团、平台活动等营销合作协议',
    sort: 40,
  },
] as const;

const DEFAULT_PROTOCOL_SEEDS: ProtocolSeed[] = [
  {
    key: 'platform_user_service_agreement',
    title: '平台用户服务协议',
    categoryName: 'C 端用户协议（用户勾选）',
    content: '<p>请编辑平台用户服务协议内容。</p>',
    enabled: false,
    sort: 10,
    remark: '整合原用户协议、平台服务协议、会员注册协议',
  },
  {
    key: 'member_service_agreement',
    title: '会员服务协议',
    categoryName: 'C 端用户协议（用户勾选）',
    content: '<p>请编辑会员服务协议内容。</p>',
    enabled: false,
    sort: 20,
    remark: '付费会员专属协议',
  },
  {
    key: 'privacy_policy_cookie',
    title: '隐私政策 + Cookie 使用说明',
    categoryName: 'C 端用户协议（用户勾选）',
    content: '<p>请编辑隐私政策与 Cookie 使用说明。</p>',
    enabled: false,
    sort: 30,
    remark: '隐私政策与 Cookie 使用说明',
  },
  {
    key: 'minor_protection_rules',
    title: '未成年人保护专项规则',
    categoryName: 'C 端用户协议（用户勾选）',
    content: '<p>请编辑未成年人保护专项规则。</p>',
    enabled: false,
    sort: 40,
    remark: '未成年人保护专项规则',
  },
  {
    key: 'order_service_agreement',
    title: '下单服务协议',
    categoryName: 'C 端用户协议（用户勾选）',
    content: '<p>请编辑下单服务协议内容。</p>',
    enabled: false,
    sort: 50,
    remark: '用户下单前勾选的服务协议',
  },
  {
    key: 'after_sales_service_agreement',
    title: '售后服务协议',
    categoryName: 'C 端用户协议（用户勾选）',
    content: '<p>请编辑售后服务协议内容。</p>',
    enabled: false,
    sort: 60,
    remark: '售后服务说明',
  },
  {
    key: 'wallet_service_agreement',
    title: '平台钱包服务协议',
    categoryName: 'C 端用户协议（用户勾选）',
    content: '<p>请编辑平台钱包服务协议内容。</p>',
    enabled: false,
    sort: 70,
    remark: '钱包账户服务说明',
  },
  {
    key: 'recharge_service_agreement',
    title: '充值服务协议、预付储值须知',
    categoryName: 'C 端用户协议（用户勾选）',
    content: '<p>请编辑充值服务协议与预付储值须知。</p>',
    enabled: false,
    sort: 80,
    remark: '充值及预付储值说明',
  },
  {
    key: 'passwordless_payment_authorization',
    title: '免密支付 / 快捷扣款授权协议',
    categoryName: 'C 端用户协议（用户勾选）',
    content: '<p>请编辑免密支付或快捷扣款授权协议。</p>',
    enabled: false,
    sort: 90,
    remark: '免密支付/快捷扣款授权',
  },
  {
    key: 'merchant_entry_cooperation_agreement',
    title: '商户入驻合作协议',
    categoryName: 'B 端商户协议（商家入驻签约）',
    content: '<p>请编辑商户入驻合作协议。</p>',
    enabled: false,
    sort: 100,
    remark: 'B端商户入驻签约',
  },
  {
    key: 'merchant_settlement_agreement',
    title: '商户结算协议',
    categoryName: 'B 端商户协议（商家入驻签约）',
    content: '<p>请编辑商户结算协议。</p>',
    enabled: false,
    sort: 110,
    remark: 'B端商户结算条款',
  },
  {
    key: 'merchant_deposit_agreement',
    title: '商户保证金协议',
    categoryName: 'B 端商户协议（商家入驻签约）',
    content: '<p>请编辑商户保证金协议。</p>',
    enabled: false,
    sort: 120,
    remark: 'B端商户保证金条款',
  },
  {
    key: 'product_service_publish_rules',
    title: '商品 / 服务发布管理规范',
    categoryName: 'B 端商户协议（商家入驻签约）',
    content: '<p>请编辑商品或服务发布管理规范。</p>',
    enabled: false,
    sort: 130,
    remark: '商品/服务发布规范',
  },
  {
    key: 'platform_advertising_cooperation_agreement',
    title: '平台广告投放协议（商家投流）',
    categoryName: 'B 端商户协议（商家入驻签约）',
    content: '<p>请编辑平台广告投放协议。</p>',
    enabled: false,
    sort: 140,
    remark: '商家投流合作协议',
  },
  {
    key: 'revenue_sharing_service_agreement',
    title: '分账服务协议',
    categoryName: '平台对外合作协议（平台和第三方公司签）',
    content: '<p>请编辑分账服务协议。</p>',
    enabled: false,
    sort: 150,
    remark: '平台对外合作协议',
  },
  {
    key: 'third_party_payment_cooperation_agreement',
    title: '第三方支付合作协议',
    categoryName: '平台对外合作协议（平台和第三方公司签）',
    content: '<p>请编辑第三方支付合作协议。</p>',
    enabled: false,
    sort: 160,
    remark: '平台对外合作协议',
  },
  {
    key: 'electronic_signature_usage_agreement',
    title: '电子签章使用协议',
    categoryName: '平台对外合作协议（平台和第三方公司签）',
    content: '<p>请编辑电子签章使用协议。</p>',
    enabled: false,
    sort: 170,
    remark: '平台对外合作协议',
  },
  {
    key: 'marketing_activity_cooperation_agreement',
    title: '营销活动合作协议',
    categoryName: '营销活动合作协议',
    content: '<p>请编辑营销活动合作协议。</p>',
    enabled: false,
    sort: 180,
    remark: '优惠券、拼团、平台活动等合作协议',
  },
];

const SEED_BY_KEY = new Map(DEFAULT_PROTOCOL_SEEDS.map((item) => [item.key, item]));
function normalizeText(value: any) {
  return String(value || '').trim();
}

function normalizeCategoryKey(value: any) {
  return normalizeText(value).replace(/\s+/g, '').replace(/[（）()]/g, '');
}

function normalizeCategory(row: MiniappProtocolCategory): MiniappProtocolCategoryItem {
  return {
    id: Number(row.id),
    name: normalizeText(row.name),
    description: normalizeText(row.description) || undefined,
    sort: Number(row.sort || 0),
    enabled: Boolean(row.enabled),
    createdAt: row.createdAt ? String(row.createdAt) : undefined,
    updatedAt: row.updatedAt ? String(row.updatedAt) : undefined,
  };
}

type MiniappProtocolWithCategory = Prisma.MiniappProtocolGetPayload<{
  include: {
    category: true;
  };
}>;

function normalizeProtocol(row: MiniappProtocolWithCategory | MiniappProtocol): MiniappProtocolItem {
  const category = (row as MiniappProtocolWithCategory).category || null;
  return {
    id: Number(row.id),
    categoryId: Number(row.categoryId),
    category: category
      ? {
          id: Number(category.id),
          name: normalizeText(category.name),
          description: normalizeText(category.description) || undefined,
          sort: Number(category.sort || 0),
          enabled: Boolean(category.enabled),
        }
      : null,
    key: normalizeText(row.key),
    title: normalizeText(row.title),
    coverImage: normalizeText(row.coverImage) || undefined,
    content: normalizeText(row.content),
    enabled: Boolean(row.enabled),
    remark: normalizeText(row.remark) || undefined,
    sort: Number(row.sort || 0),
    createdAt: row.createdAt ? String(row.createdAt) : undefined,
    updatedAt: row.updatedAt ? String(row.updatedAt) : undefined,
  };
}

function sortCategories(list: MiniappProtocolCategoryItem[]) {
  return [...list].sort((a, b) => {
    const diff = Number(a.sort || 0) - Number(b.sort || 0);
    if (diff !== 0) return diff;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
  });
}

function sortProtocols(list: MiniappProtocolItem[]) {
  return [...list].sort((a, b) => {
    const categoryDiff = Number(a.category?.sort || 0) - Number(b.category?.sort || 0);
    if (categoryDiff !== 0) return categoryDiff;
    const sortDiff = Number(a.sort || 0) - Number(b.sort || 0);
    if (sortDiff !== 0) return sortDiff;
    return String(a.key || '').localeCompare(String(b.key || ''), 'zh-Hans-CN');
  });
}

function isValidProtocolKey(value: string) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(normalizeText(value));
}

function normalizeKeyList(input: string | string[]) {
  const raw = Array.isArray(input) ? input : [input];
  const list = raw
    .flatMap((item) => String(item || '').split(','))
    .map((item) => normalizeText(item))
    .filter(Boolean);
  return Array.from(new Set(list));
}

@Injectable()
export class MiniappProtocolsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async onModuleInit() {
    await this.ensureSeed();
  }

  private async listLegacyProtocols() {
    const [legacy, categories] = await Promise.all([
      this.systemConfigService.getJson<any[]>(
        SystemConfigService.KEYS.MINIAPP_PROTOCOLS,
        [],
      ),
      this.prisma.miniappProtocolCategory.findMany(),
    ]);

    const categoryByName = new Map(
      categories.map((item) => [normalizeText(item.name), normalizeCategory(item)]),
    );

    return (Array.isArray(legacy) ? legacy : [])
      .map((raw) => {
        const key = normalizeText(raw?.key);
        if (!key || !isValidProtocolKey(key)) return null;

        const seed = SEED_BY_KEY.get(key);
        const title = normalizeText(raw?.title || seed?.title);
        const content = normalizeText(raw?.content || seed?.content);
        const categoryName = normalizeText(raw?.categoryName || seed?.categoryName);
        const category = categoryByName.get(categoryName) || null;
        const enabled = raw?.enabled === undefined ? seed?.enabled !== false : raw?.enabled !== false;

        if (!enabled || !title || !content) return null;

        return {
          id: 0,
          categoryId: Number(category?.id || 0),
          category,
          key,
          title,
          coverImage: normalizeText(raw?.coverImage || seed?.coverImage) || undefined,
          content,
          enabled: true,
          remark: normalizeText(raw?.remark || seed?.remark) || undefined,
          sort: Number.isFinite(Number(raw?.sort)) ? Number(raw.sort) : Number(seed?.sort || 0),
        } as MiniappProtocolItem;
      })
      .filter(Boolean) as MiniappProtocolItem[];
  }

  private async ensureSeed() {
    for (const item of DEFAULT_CATEGORIES) {
      const existing = await this.prisma.miniappProtocolCategory.findFirst({
        where: { name: item.name },
      });
      if (existing) continue;
      await this.prisma.miniappProtocolCategory.create({
        data: {
          name: item.name,
          description: item.description,
          sort: item.sort,
          enabled: true,
        },
      });
    }

    const protocolCount = await this.prisma.miniappProtocol.count();
    if (protocolCount > 0) return;

    const categories = await this.prisma.miniappProtocolCategory.findMany({
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });
    const categoryIdByName = new Map(categories.map((item) => [normalizeText(item.name), Number(item.id)]));
    const fallbackCategoryId = Number(categories[0]?.id || 0);

    const legacy = await this.systemConfigService.getJson<any[]>(
      SystemConfigService.KEYS.MINIAPP_PROTOCOLS,
      [],
    );
    const source = Array.isArray(legacy) && legacy.length ? legacy : DEFAULT_PROTOCOL_SEEDS;
    const rows = source
      .map((raw) => {
        const key = normalizeText(raw?.key);
        if (!key || !isValidProtocolKey(key)) return null;
        const seed = SEED_BY_KEY.get(key);
        const categoryName = normalizeText(raw?.categoryName || seed?.categoryName);
        const categoryId = Number(categoryIdByName.get(categoryName) || fallbackCategoryId || 0);
        if (!categoryId) return null;
        const title = normalizeText(raw?.title || seed?.title);
        const content = normalizeText(raw?.content || seed?.content);
        if (!title || !content) return null;
        return {
          categoryId,
          key,
          title,
          coverImage: normalizeText(raw?.coverImage || seed?.coverImage) || undefined,
          content,
          enabled: raw?.enabled !== false && seed?.enabled !== false,
          remark: normalizeText(raw?.remark || seed?.remark) || undefined,
          sort: Number.isFinite(Number(raw?.sort)) ? Number(raw.sort) : Number(seed?.sort || 0),
        };
      })
      .filter(Boolean) as Array<{
      categoryId: number;
      key: string;
      title: string;
      coverImage?: string;
      content: string;
      enabled: boolean;
      remark?: string;
      sort: number;
    }>;

    if (rows.length) {
      await this.prisma.miniappProtocol.createMany({
        data: rows,
        skipDuplicates: true,
      });
    }
  }

  async listCategories() {
    const [categories, counts] = await Promise.all([
      this.prisma.miniappProtocolCategory.findMany({
        orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.miniappProtocol.groupBy({
        by: ['categoryId'],
        _count: { _all: true },
      }),
    ]);

    const countMap = new Map<number, number>();
    counts.forEach((row) => countMap.set(Number(row.categoryId), Number(row._count._all || 0)));

    return sortCategories(
      categories.map((row) => ({
        ...normalizeCategory(row),
        protocolCount: countMap.get(Number(row.id)) || 0,
      })),
    );
  }

  async upsertCategory(dto: UpsertMiniappProtocolCategoryDto) {
    const id = Number(dto.id || 0);
    const name = normalizeText(dto.name);
    const description = normalizeText(dto.description);
    const sort = Number.isFinite(Number(dto.sort)) ? Number(dto.sort) : 0;
    const enabled = dto.enabled !== false;

    if (!name) {
      throw new BadRequestException('分类名称不能为空');
    }

    const duplicate = await this.prisma.miniappProtocolCategory.findFirst({
      where: {
        name,
        ...(id ? { id: { not: id } } : {}),
      },
    });
    if (duplicate) {
      throw new BadRequestException(`分类名称已存在：${name}`);
    }

    if (id) {
      const existing = await this.prisma.miniappProtocolCategory.findUnique({ where: { id } });
      if (!existing) throw new BadRequestException('分类不存在');
      await this.prisma.miniappProtocolCategory.update({
        where: { id },
        data: { name, description: description || null, sort, enabled },
      });
    } else {
      await this.prisma.miniappProtocolCategory.create({
        data: { name, description: description || null, sort, enabled },
      });
    }

    return this.listCategories();
  }

  async removeCategory(id: number) {
    const categoryId = Number(id || 0);
    if (!categoryId) throw new BadRequestException('分类ID不能为空');

    const existing = await this.prisma.miniappProtocolCategory.findUnique({ where: { id: categoryId } });
    if (!existing) throw new BadRequestException('分类不存在');

    const protocolCount = await this.prisma.miniappProtocol.count({
      where: { categoryId },
    });
    if (protocolCount > 0) {
      throw new BadRequestException('该分类下仍有关联协议，无法删除。请先调整协议分类或停用该分类。');
    }

    await this.prisma.miniappProtocolCategory.delete({ where: { id: categoryId } });
    return this.listCategories();
  }

  async listAll() {
    const protocols = await this.prisma.miniappProtocol.findMany({
      include: {
        category: true,
      },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });
    return sortProtocols(protocols.map((row) => normalizeProtocol(row)));
  }

  async getByKey(key: string) {
    const targetKey = normalizeText(key);
    if (!targetKey || !isValidProtocolKey(targetKey)) return null;

    const row = await this.prisma.miniappProtocol.findUnique({
      where: { key: targetKey },
      include: { category: true },
    });

    if (row && row.enabled && normalizeText(row.content)) {
      return normalizeProtocol(row);
    }

    const legacy = (await this.listLegacyProtocols()).find((item) => normalizeText(item.key) === targetKey) || null;
    return legacy;
  }

  async listPublicByKeys(keys: string | string[]) {
    const targetKeys = normalizeKeyList(keys).filter((item) => isValidProtocolKey(item));
    if (!targetKeys.length) return [];

    const rows = await this.prisma.miniappProtocol.findMany({
      where: {
        key: { in: targetKeys },
        enabled: true,
      },
      include: { category: true },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });

    const protocolMap = new Map(
      rows
        .filter((row) => normalizeText(row.content))
        .map((row) => [normalizeText(row.key), normalizeProtocol(row)]),
    );

    const missingKeys = targetKeys.filter((key) => !protocolMap.has(key));
    if (missingKeys.length) {
      const legacyMap = new Map(
        (await this.listLegacyProtocols()).map((item) => [normalizeText(item.key), item]),
      );
      missingKeys.forEach((key) => {
        const legacy = legacyMap.get(key);
        if (legacy) {
          protocolMap.set(key, legacy);
        }
      });
    }

    return targetKeys
      .map((key) => protocolMap.get(key) || null)
      .filter(Boolean) as MiniappProtocolItem[];
  }

  async listPublicByCategoryName(categoryName: string) {
    const targetCategoryName = normalizeText(categoryName);
    if (!targetCategoryName) return [];
    const targetCategoryKey = normalizeCategoryKey(targetCategoryName);

    const categories = await this.prisma.miniappProtocolCategory.findMany({
      where: { enabled: true },
    });
    const category = categories.find((item) => {
      const currentName = normalizeText(item.name);
      const currentKey = normalizeCategoryKey(currentName);
      return currentName === targetCategoryName
        || currentKey === targetCategoryKey
        || currentKey.includes(targetCategoryKey)
        || targetCategoryKey.includes(currentKey);
    });
    if (!category) return [];

    const rows = await this.prisma.miniappProtocol.findMany({
      where: {
        categoryId: category.id,
        enabled: true,
      },
      include: {
        category: true,
      },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });

    return sortProtocols(rows.map((row) => normalizeProtocol(row)));
  }

  async upsert(dto: UpsertMiniappProtocolDto) {
    const key = normalizeText(dto.key);
    const originalKey = normalizeText(dto.originalKey);
    const title = normalizeText(dto.title);
    const coverImage = normalizeText(dto.coverImage);
    const content = normalizeText(dto.content);
    const remark = normalizeText(dto.remark);
    const sort = Number.isFinite(Number(dto.sort)) ? Number(dto.sort) : 0;
    const categoryId = Number(dto.categoryId || 0);
    const enabled = dto.enabled !== false;

    if (!isValidProtocolKey(key)) {
      throw new BadRequestException('协议键仅支持字母、数字、下划线、中划线，长度不超过 64');
    }
    if (originalKey && !isValidProtocolKey(originalKey)) {
      throw new BadRequestException('原协议键格式无效');
    }
    if (!title) throw new BadRequestException('协议标题不能为空');
    if (!content) throw new BadRequestException('协议内容不能为空');
    if (!categoryId) throw new BadRequestException('请选择协议分类');

    const category = await this.prisma.miniappProtocolCategory.findUnique({ where: { id: categoryId } });
    if (!category) throw new BadRequestException('协议分类不存在');

    const targetKey = originalKey || key;
    const existing = await this.prisma.miniappProtocol.findUnique({ where: { key: targetKey } });
    if (key !== targetKey) {
      const duplicate = await this.prisma.miniappProtocol.findUnique({ where: { key } });
      if (duplicate && duplicate.id !== existing?.id) {
        throw new BadRequestException(`协议键已存在：${key}`);
      }
    }

    const data = {
      categoryId,
      key,
      title,
      coverImage: coverImage || null,
      content,
      enabled,
      remark: remark || null,
      sort,
    };

    if (existing) {
      await this.prisma.miniappProtocol.update({
        where: { id: existing.id },
        data,
      });
    } else {
      await this.prisma.miniappProtocol.create({ data });
    }

    return this.listAll();
  }

  async remove(idOrKey: { id?: number; key?: string }) {
    const id = Number(idOrKey?.id || 0);
    const key = normalizeText(idOrKey?.key);
    let existing: MiniappProtocol | null = null;

    if (id) {
      existing = await this.prisma.miniappProtocol.findUnique({ where: { id } });
    } else if (key) {
      existing = await this.prisma.miniappProtocol.findUnique({ where: { key } });
    }

    if (!existing) {
      throw new BadRequestException('协议不存在');
    }

    await this.prisma.miniappProtocol.delete({ where: { id: existing.id } });
    return this.listAll();
  }
}
