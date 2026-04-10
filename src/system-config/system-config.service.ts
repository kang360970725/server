import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { UpsertSystemConfigDto } from './dto/upsert-system-config.dto';

@Injectable()
export class SystemConfigService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensureDefaults();
  }

  static readonly KEYS = {
    OFFLINE_FEE_RATE: 'offline_fee_rate',
    OFFLINE_FEE_MIN: 'offline_fee_min',
    OFFLINE_FEE_CAP: 'offline_fee_cap',
    OFFLINE_FEE_PARTIAL_MIN_PAY: 'offline_fee_partial_min_pay',
  } as const;

  async ensureDefaults() {
    const defaults = [
      {
        key: SystemConfigService.KEYS.OFFLINE_FEE_RATE,
        value: '0.1',
        valueType: 'NUMBER',
        remark: '线下运营成本比例（总业绩 * rate）',
      },
      {
        key: SystemConfigService.KEYS.OFFLINE_FEE_MIN,
        value: '100',
        valueType: 'NUMBER',
        remark: '线下运营成本最低值',
      },
      {
        key: SystemConfigService.KEYS.OFFLINE_FEE_CAP,
        value: '3000',
        valueType: 'NUMBER',
        remark: '线下运营成本封顶值',
      },
      {
        key: SystemConfigService.KEYS.OFFLINE_FEE_PARTIAL_MIN_PAY,
        value: '100',
        valueType: 'NUMBER',
        remark: '提现时线下运营成本最小部分缴纳金额',
      },
    ] as const;

    for (const item of defaults) {
      await this.prisma.systemConfig.upsert({
        where: { key: item.key },
        update: {},
        create: {
          key: item.key,
          value: item.value,
          valueType: item.valueType as any,
          remark: item.remark,
          enabled: true,
        },
      });
    }
  }

  async listAll() {
    return this.prisma.systemConfig.findMany({
      orderBy: { key: 'asc' },
    });
  }

  async upsert(dto: UpsertSystemConfigDto) {
    return this.prisma.systemConfig.upsert({
      where: { key: dto.key },
      update: {
        value: dto.value,
        valueType: (dto.valueType as any) ?? undefined,
        remark: dto.remark,
        enabled: dto.enabled,
      },
      create: {
        key: dto.key,
        value: dto.value,
        valueType: (dto.valueType as any) ?? 'STRING',
        remark: dto.remark,
        enabled: dto.enabled ?? true,
      },
    });
  }

  async getRawByKey(key: string) {
    return this.prisma.systemConfig.findUnique({ where: { key } });
  }

  async getNumber(key: string, fallback = 0) {
    const row = await this.getRawByKey(key);
    if (!row || !row.enabled) return fallback;

    const n = Number(row.value);
    return Number.isFinite(n) ? n : fallback;
  }
}
