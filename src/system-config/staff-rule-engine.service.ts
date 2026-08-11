import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SystemConfigService } from './system-config.service';

export type StaffRuleTag = {
  code: string;
  name: string;
  enabled?: boolean;
  sort?: number;
};

export type StaffRuleItem = {
  id: string;
  name: string;
  enabled?: boolean;
  priority?: number;
  tagCodes: string[];
  depositAmount: number;
  firstWithdrawMinBalance: number;
  firstWithdrawMinAcceptedDays: number;
  quitCoolingDays: number;
  depositForfeitDays: number;
  dormantFreezeDays: number;
  settlementFreezeExperienceDays: number;
  settlementFreezeRegularDays: number;
  refundWhenDepositInsufficient?: boolean;
};

export type StaffRuleEngineConfig = {
  tags: StaffRuleTag[];
  rules: StaffRuleItem[];
  defaultRule: StaffRuleItem;
};

@Injectable()
export class StaffRuleEngineService {
  constructor(private readonly prisma: PrismaService) {}

  getDefaultConfig(): StaffRuleEngineConfig {
    return { tags: [], rules: [], defaultRule: this.getDefaultRule() };
  }

  getDefaultRule(): StaffRuleItem {
    return {
      id: 'default_rule',
      name: '默认规则',
      enabled: true,
      priority: -1,
      tagCodes: [],
      depositAmount: 500,
      firstWithdrawMinBalance: 1000,
      firstWithdrawMinAcceptedDays: 15,
      quitCoolingDays: 180,
      depositForfeitDays: 30,
      dormantFreezeDays: 7,
      settlementFreezeExperienceDays: 3,
      settlementFreezeRegularDays: 7,
      refundWhenDepositInsufficient: true,
    };
  }

  private normalizeTagCode(code: any) {
    return String(code || '').trim().toLowerCase();
  }

  private normalizeTagName(name: any) {
    return String(name || '').trim();
  }

  private toSafeNumber(value: any, fieldLabel: string) {
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      throw new BadRequestException(`${fieldLabel}必须为大于等于 0 的数字`);
    }
    return num;
  }

  private normalizeRuleItem(item: any, index: number, tagCodeSet: Set<string>, options?: { defaultRule?: boolean; allowMultipleTags?: boolean }): StaffRuleItem {
    const isDefaultRule = Boolean(options?.defaultRule);
    const fallbackDefault = this.getDefaultRule();
    const id = String(item?.id || (isDefaultRule ? fallbackDefault.id : '')).trim();
    const name = String(item?.name || (isDefaultRule ? fallbackDefault.name : '')).trim();
    const tagCodes = Array.isArray(item?.tagCodes)
      ? item.tagCodes.map((tag: any) => this.normalizeTagCode(tag)).filter(Boolean)
      : [];

    if (!id) throw new BadRequestException(`第 ${index + 1} 条规则缺少 id`);
    if (!name) throw new BadRequestException(`第 ${index + 1} 条规则缺少名称`);
    if (isDefaultRule) {
      if (tagCodes.length) throw new BadRequestException('默认规则不能关联服务者规则分组');
    } else {
      if (options?.allowMultipleTags) {
        if (!tagCodes.length) throw new BadRequestException(`规则 ${name} 至少关联一个规则分组`);
      } else if (tagCodes.length !== 1) {
        throw new BadRequestException(`规则 ${name} 必须且只能关联一个规则分组`);
      }
      tagCodes.forEach((tagCode) => {
        if (!tagCodeSet.has(tagCode)) {
          throw new BadRequestException(`规则 ${name} 关联了不存在的规则分组：${tagCode}`);
        }
      });
    }

    return {
      id,
      name,
      enabled: item?.enabled !== false,
      priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : (isDefaultRule ? fallbackDefault.priority : 0),
      tagCodes: Array.from(new Set(tagCodes)),
      depositAmount: item?.depositAmount === undefined || item?.depositAmount === null
        ? fallbackDefault.depositAmount
        : this.toSafeNumber(item?.depositAmount, `规则 ${name} 的押金金额`),
      firstWithdrawMinBalance: item?.firstWithdrawMinBalance === undefined || item?.firstWithdrawMinBalance === null
        ? fallbackDefault.firstWithdrawMinBalance
        : this.toSafeNumber(item?.firstWithdrawMinBalance, `规则 ${name} 的首次提现金额限制`),
      firstWithdrawMinAcceptedDays: item?.firstWithdrawMinAcceptedDays === undefined || item?.firstWithdrawMinAcceptedDays === null
        ? fallbackDefault.firstWithdrawMinAcceptedDays
        : this.toSafeNumber(item?.firstWithdrawMinAcceptedDays, `规则 ${name} 的首次提现接单天数限制`),
      quitCoolingDays: item?.quitCoolingDays === undefined || item?.quitCoolingDays === null
        ? fallbackDefault.quitCoolingDays
        : this.toSafeNumber(item?.quitCoolingDays, `规则 ${name} 的退店冷却期`),
      depositForfeitDays: item?.depositForfeitDays === undefined || item?.depositForfeitDays === null
        ? fallbackDefault.depositForfeitDays
        : this.toSafeNumber(item?.depositForfeitDays, `规则 ${name} 的押金不退限制`),
      dormantFreezeDays: item?.dormantFreezeDays === undefined || item?.dormantFreezeDays === null
        ? fallbackDefault.dormantFreezeDays
        : this.toSafeNumber(item?.dormantFreezeDays, `规则 ${name} 的自动冻结周期`),
      settlementFreezeExperienceDays: item?.settlementFreezeExperienceDays === undefined || item?.settlementFreezeExperienceDays === null
        ? fallbackDefault.settlementFreezeExperienceDays
        : this.toSafeNumber(item?.settlementFreezeExperienceDays, `规则 ${name} 的体验单结算冻结周期`),
      settlementFreezeRegularDays: item?.settlementFreezeRegularDays === undefined || item?.settlementFreezeRegularDays === null
        ? fallbackDefault.settlementFreezeRegularDays
        : this.toSafeNumber(item?.settlementFreezeRegularDays, `规则 ${name} 的普通单结算冻结周期`),
      refundWhenDepositInsufficient: true,
    };
  }

  normalizeConfig(input: any, options?: { allowLegacyMultipleTags?: boolean }): StaffRuleEngineConfig {
    const raw = input && typeof input === 'object' ? input : {};
    const tags = Array.isArray(raw.tags) ? raw.tags : [];
    const rules = Array.isArray(raw.rules) ? raw.rules : [];

    const normalizedTags = tags.map((item: any, index: number) => {
      const code = this.normalizeTagCode(item?.code);
      const name = this.normalizeTagName(item?.name);
      if (!code) throw new BadRequestException(`第 ${index + 1} 个标签缺少 code`);
      if (!name) throw new BadRequestException(`第 ${index + 1} 个标签缺少名称`);
      return {
        code,
        name,
        enabled: item?.enabled !== false,
        sort: Number.isFinite(Number(item?.sort)) ? Number(item.sort) : index + 1,
      };
    });

    const tagCodeSet = new Set<string>();
    normalizedTags.forEach((item) => {
      if (tagCodeSet.has(item.code)) {
        throw new BadRequestException(`规则分组编码重复：${item.code}`);
      }
      tagCodeSet.add(item.code);
    });

    const normalizedRules = rules.map((item: any, index: number) =>
      this.normalizeRuleItem(item, index, tagCodeSet, { allowMultipleTags: Boolean(options?.allowLegacyMultipleTags) }),
    );
    const normalizedDefaultRule = this.normalizeRuleItem(
      raw.defaultRule && typeof raw.defaultRule === 'object' ? raw.defaultRule : this.getDefaultRule(),
      0,
      tagCodeSet,
      { defaultRule: true },
    );

    const ruleIdSet = new Set<string>();
    normalizedRules.forEach((item) => {
      if (ruleIdSet.has(item.id)) {
        throw new BadRequestException(`规则 ID 重复：${item.id}`);
      }
      ruleIdSet.add(item.id);
    });

    return {
      tags: normalizedTags.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0)),
      rules: normalizedRules.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0)),
      defaultRule: normalizedDefaultRule,
    };
  }

  async getConfig() {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: SystemConfigService.KEYS.STAFF_RULE_ENGINE_V1 },
      select: { value: true },
    });

    if (!row?.value) return this.getDefaultConfig();

    try {
      return this.normalizeConfig(JSON.parse(String(row.value || '{}')), { allowLegacyMultipleTags: true });
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('员工规则配置格式错误，请先修正基础配置');
    }
  }

  async upsertConfig(input: any) {
    const normalized = this.normalizeConfig(input);
    return this.prisma.systemConfig.upsert({
      where: { key: SystemConfigService.KEYS.STAFF_RULE_ENGINE_V1 },
      create: {
        key: SystemConfigService.KEYS.STAFF_RULE_ENGINE_V1,
        value: JSON.stringify(normalized, null, 2),
        valueType: 'JSON',
        remark: '服务者规则分组与提现/退店规则配置',
        enabled: true,
      },
      update: {
        value: JSON.stringify(normalized, null, 2),
        valueType: 'JSON',
        remark: '服务者规则分组与提现/退店规则配置',
        enabled: true,
      },
    });
  }

  normalizeUserTags(input: any): string[] {
    if (!Array.isArray(input)) return [];
    return Array.from(new Set(input.map((item) => this.normalizeTagCode(item)).filter(Boolean)));
  }

  resolveMatchedRule(config: StaffRuleEngineConfig, staffTags: any): StaffRuleItem | null {
    const tagSet = new Set(this.normalizeUserTags(staffTags));
    const defaultRule = config?.defaultRule || this.getDefaultRule();

    const activeTags = new Set(
      (Array.isArray(config?.tags) ? config.tags : [])
        .filter((item) => item?.enabled !== false)
        .map((item) => this.normalizeTagCode(item.code)),
    );

    const rules = Array.isArray(config?.rules) && tagSet.size ? config.rules : [];
    for (const rule of rules) {
      if (rule?.enabled === false) continue;
      const ruleTags = Array.isArray(rule?.tagCodes) ? rule.tagCodes.map((item) => this.normalizeTagCode(item)) : [];
      if (!ruleTags.length) continue;
      const hasMatch = ruleTags.some((tagCode) => activeTags.has(tagCode) && tagSet.has(tagCode));
      if (hasMatch) {
        return {
          ...rule,
          tagCodes: ruleTags,
          firstWithdrawMinAcceptedDays: Number(rule?.firstWithdrawMinAcceptedDays ?? 15),
          dormantFreezeDays: Number(rule?.dormantFreezeDays ?? 7),
          settlementFreezeExperienceDays: Number(rule?.settlementFreezeExperienceDays ?? 3),
          settlementFreezeRegularDays: Number(rule?.settlementFreezeRegularDays ?? 7),
          refundWhenDepositInsufficient: true,
        };
      }
    }

    return {
      ...this.getDefaultRule(),
      ...defaultRule,
      enabled: true,
      tagCodes: [],
      firstWithdrawMinAcceptedDays: Number(defaultRule?.firstWithdrawMinAcceptedDays ?? 15),
      dormantFreezeDays: Number(defaultRule?.dormantFreezeDays ?? 7),
      settlementFreezeExperienceDays: Number(defaultRule?.settlementFreezeExperienceDays ?? 3),
      settlementFreezeRegularDays: Number(defaultRule?.settlementFreezeRegularDays ?? 7),
      refundWhenDepositInsufficient: true,
    };
  }

  getDormantFreezeDays(config: StaffRuleEngineConfig, staffTags: any): number {
    const matchedRule = this.resolveMatchedRule(config, staffTags);
    const days = Number(matchedRule?.dormantFreezeDays ?? 7);
    return Number.isFinite(days) && days >= 0 ? days : 7;
  }

  buildDormantFreezeMessage(days: number) {
    return `用户活跃度太低，已经超过${Number(days || 0)}天，账号已自动冻结，请联系管理超哥进行处理。`;
  }
}
