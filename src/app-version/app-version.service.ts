import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertAppVersionDto } from './dto/upsert-app-version.dto';

type AppVersionItem = {
  id: number;
  version: string;
  buildId: string;
  releasedAt: string;
  forceRefresh: boolean;
  title: string;
  notes: string[];
  enabled: boolean;
  createdAt: string;
  createdBy?: number | null;
};

type ReleaseType = 'SMALL' | 'MAJOR';

@Injectable()
export class AppVersionService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  private static readonly KEYS = {
    LIST: 'app_version_releases',
    ACTIVE_BUILD_ID: 'app_version_active_build_id',
  } as const;

  async onModuleInit() {
    await this.ensureDefaults();
  }

  private nowIso() {
    return new Date().toISOString();
  }

  private normalizeReleaseType(input?: string): ReleaseType {
    return String(input || 'SMALL').trim().toUpperCase() === 'MAJOR' ? 'MAJOR' : 'SMALL';
  }

  private parseVersion(input?: string): [number, number, number] {
    const raw = String(input || '').trim();
    if (!raw) return [1, 0, 0];
    const parts = raw
      .split('.')
      .map((x) => Number.parseInt(String(x || '').replace(/[^\d]/g, ''), 10))
      .filter((x) => Number.isFinite(x) && x >= 0);
    if (!parts.length) return [1, 0, 0];
    const major = Number(parts[0] ?? 1);
    const minor = Number(parts[1] ?? 0);
    const patch = Number(parts[2] ?? 0);
    return [major, minor, patch];
  }

  private buildVersion(major: number, minor: number, patch: number): string {
    return `${Math.max(0, major)}.${Math.max(0, minor)}.${Math.max(0, patch)}`;
  }

  private nextVersion(baseVersion: string | undefined, releaseType: ReleaseType): string {
    const [major, minor, patch] = this.parseVersion(baseVersion);
    if (releaseType === 'MAJOR') {
      return this.buildVersion(major + 1, 0, 0);
    }
    return this.buildVersion(major, minor, patch + 1);
  }

  private generateBuildId(version: string): string {
    const d = new Date();
    const isoCompact = d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `b${version.replace(/[^\d.]/g, '')}-${isoCompact}${ms}`;
  }

  private normalizeItem(input: any): AppVersionItem | null {
    const version = String(input?.version || '').trim();
    const buildId = String(input?.buildId || '').trim();
    if (!version || !buildId) return null;

    const notes = Array.isArray(input?.notes)
      ? input.notes.map((x: any) => String(x || '').trim()).filter(Boolean)
      : [];

    return {
      id: Number(input?.id || 0) || 0,
      version,
      buildId,
      releasedAt: String(input?.releasedAt || this.nowIso()),
      forceRefresh: Boolean(input?.forceRefresh ?? true),
      title: String(input?.title || '版本更新说明').trim() || '版本更新说明',
      notes,
      enabled: Boolean(input?.enabled ?? true),
      createdAt: String(input?.createdAt || this.nowIso()),
      createdBy: input?.createdBy ? Number(input.createdBy) : null,
    };
  }

  private sortList(list: AppVersionItem[]) {
    return [...list].sort((a, b) => {
      const t1 = new Date(a.releasedAt || a.createdAt).getTime();
      const t2 = new Date(b.releasedAt || b.createdAt).getTime();
      if (t1 !== t2) return t2 - t1;
      return Number(b.id || 0) - Number(a.id || 0);
    });
  }

  async ensureDefaults() {
    const defaults = [
      {
        key: AppVersionService.KEYS.LIST,
        value: '[]',
        valueType: 'JSON',
        remark: '前端版本迭代记录列表',
      },
      {
        key: AppVersionService.KEYS.ACTIVE_BUILD_ID,
        value: '',
        valueType: 'STRING',
        remark: '当前启用的 buildId',
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

  private async readList(): Promise<AppVersionItem[]> {
    await this.ensureDefaults();
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: AppVersionService.KEYS.LIST },
      select: { value: true, enabled: true },
    });
    if (!row?.enabled) return [];

    try {
      const raw = JSON.parse(String(row.value || '[]'));
      const list = Array.isArray(raw) ? raw : [];
      return this.sortList(list.map((x) => this.normalizeItem(x)).filter(Boolean) as AppVersionItem[]);
    } catch {
      return [];
    }
  }

  private async writeList(list: AppVersionItem[]) {
    const value = JSON.stringify(this.sortList(list));
    await this.prisma.systemConfig.update({
      where: { key: AppVersionService.KEYS.LIST },
      data: { value, valueType: 'JSON' as any, enabled: true },
    });
  }

  private async readActiveBuildId() {
    await this.ensureDefaults();
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: AppVersionService.KEYS.ACTIVE_BUILD_ID },
      select: { value: true, enabled: true },
    });
    if (!row?.enabled) return '';
    return String(row.value || '').trim();
  }

  async listAll() {
    const [list, activeBuildId] = await Promise.all([this.readList(), this.readActiveBuildId()]);
    return {
      list,
      activeBuildId,
    };
  }

  async upsert(dto: UpsertAppVersionDto, operatorId?: number) {
    const list = await this.readList();
    const now = this.nowIso();
    const releaseType = this.normalizeReleaseType(dto.releaseType);
    const latest = list[0] || null;
    const version = String(dto.version || '').trim() || this.nextVersion(latest?.version, releaseType);
    const buildId = String(dto.buildId || '').trim() || this.generateBuildId(version);
    if (!version || !buildId) {
      throw new BadRequestException('版本号或 Build ID 生成失败');
    }

    const next: AppVersionItem = {
      id: 0,
      version,
      buildId,
      releasedAt: dto.releasedAt ? new Date(dto.releasedAt).toISOString() : now,
      forceRefresh: Boolean(dto.forceRefresh ?? true),
      title: String(dto.title || '版本更新说明').trim() || '版本更新说明',
      notes: Array.isArray(dto.notes) ? dto.notes.map((x) => String(x || '').trim()).filter(Boolean) : [],
      enabled: Boolean(dto.enabled ?? true),
      createdAt: now,
      createdBy: operatorId ? Number(operatorId) : null,
    };

    const idx = list.findIndex((x) => x.buildId === buildId);
    if (idx >= 0) {
      next.id = Number(list[idx].id || 0) || idx + 1;
      next.createdAt = String(list[idx].createdAt || now);
      next.createdBy = list[idx].createdBy ?? (operatorId ? Number(operatorId) : null);
      list[idx] = next;
    } else {
      const maxId = list.reduce((m, x) => Math.max(m, Number(x.id || 0)), 0);
      next.id = maxId + 1;
      list.unshift(next);
    }

    await this.writeList(list);
    return next;
  }

  async activateBuild(buildId: string) {
    const target = String(buildId || '').trim();
    const list = await this.readList();
    const exists = list.find((x) => x.buildId === target && x.enabled);
    if (!exists) {
      throw new BadRequestException('目标 buildId 不存在或已禁用');
    }
    await this.prisma.systemConfig.update({
      where: { key: AppVersionService.KEYS.ACTIVE_BUILD_ID },
      data: { value: target, valueType: 'STRING' as any, enabled: true },
    });
    return { success: true, activeBuildId: target };
  }

  async getLatestPublic() {
    const [list, activeBuildId] = await Promise.all([this.readList(), this.readActiveBuildId()]);
    const enabled = list.filter((x) => x.enabled);
    if (!enabled.length) return null;

    const active = enabled.find((x) => x.buildId === activeBuildId);
    const latest = active || this.sortList(enabled)[0];
    return latest || null;
  }
}
