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
  quitCoolingDays: number;
  depositForfeitDays: number;
  refundWhenDepositInsufficient?: boolean;
};

export type StaffRuleEngineConfig = {
  tags: StaffRuleTag[];
  rules: StaffRuleItem[];
};

@Injectable()
export class StaffRuleEngineService {
  constructor(private readonly prisma: PrismaService) {}

  getDefaultConfig(): StaffRuleEngineConfig {
    return { tags: [], rules: [] };
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

  normalizeConfig(input: any): StaffRuleEngineConfig {
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
        throw new BadRequestException(`标签编码重复：${item.code}`);
      }
      tagCodeSet.add(item.code);
    });

    const normalizedRules = rules.map((item: any, index: number) => {
      const id = String(item?.id || '').trim();
      const name = String(item?.name || '').trim();
      const tagCodes = Array.isArray(item?.tagCodes)
        ? item.tagCodes.map((tag: any) => this.normalizeTagCode(tag)).filter(Boolean)
        : [];

      if (!id) throw new BadRequestException(`第 ${index + 1} 条规则缺少 id`);
      if (!name) throw new BadRequestException(`第 ${index + 1} 条规则缺少名称`);
      if (!tagCodes.length) throw new BadRequestException(`规则 ${name} 至少关联一个标签`);

      tagCodes.forEach((tagCode) => {
        if (!tagCodeSet.has(tagCode)) {
          throw new BadRequestException(`规则 ${name} 关联了不存在的标签：${tagCode}`);
        }
      });

      return {
        id,
        name,
        enabled: item?.enabled !== false,
        priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : 0,
        tagCodes: Array.from(new Set(tagCodes)),
        depositAmount: this.toSafeNumber(item?.depositAmount, `规则 ${name} 的押金金额`),
        firstWithdrawMinBalance: this.toSafeNumber(item?.firstWithdrawMinBalance, `规则 ${name} 的首次提现金额限制`),
        quitCoolingDays: this.toSafeNumber(item?.quitCoolingDays, `规则 ${name} 的退店冷却期`),
        depositForfeitDays: this.toSafeNumber(item?.depositForfeitDays, `规则 ${name} 的押金不退限制`),
        refundWhenDepositInsufficient: true,
      };
    });

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
    };
  }

  async getConfig() {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: SystemConfigService.KEYS.STAFF_RULE_ENGINE_V1 },
      select: { value: true },
    });

    if (!row?.value) return this.getDefaultConfig();

    try {
      return this.normalizeConfig(JSON.parse(String(row.value || '{}')));
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
        remark: '员工标签与提现/退店规则配置',
        enabled: true,
      },
      update: {
        value: JSON.stringify(normalized, null, 2),
        valueType: 'JSON',
        remark: '员工标签与提现/退店规则配置',
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
    if (!tagSet.size) return null;

    const activeTags = new Set(
      (Array.isArray(config?.tags) ? config.tags : [])
        .filter((item) => item?.enabled !== false)
        .map((item) => this.normalizeTagCode(item.code)),
    );

    const rules = Array.isArray(config?.rules) ? config.rules : [];
    for (const rule of rules) {
      if (rule?.enabled === false) continue;
      const ruleTags = Array.isArray(rule?.tagCodes) ? rule.tagCodes.map((item) => this.normalizeTagCode(item)) : [];
      if (!ruleTags.length) continue;
      const hasMatch = ruleTags.some((tagCode) => activeTags.has(tagCode) && tagSet.has(tagCode));
      if (hasMatch) {
        return {
          ...rule,
          tagCodes: ruleTags,
          refundWhenDepositInsufficient: true,
        };
      }
    }

    return null;
  }
}
