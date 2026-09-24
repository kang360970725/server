import { Injectable } from '@nestjs/common';
import { SystemConfigService } from '../system-config/system-config.service';

export type MiniRuntimeMode = 'REVIEW' | 'NORMAL';

const REVIEW_FEATURES = {
  memberCenter: true,
  memberRights: true,
  coupons: true,
  checkin: true,
  gameCards: true,
  serviceRecords: true,
  wallet: false,
  balanceDisplay: false,
  recharge: false,
  serviceMarket: false,
  productPrice: false,
  payment: false,
  pendingPayment: false,
  customerService: false,
  wechatQrCode: false,
  staffPublicCard: false,
} as const;

const NORMAL_FEATURES = Object.fromEntries(
  Object.keys(REVIEW_FEATURES).map((key) => [key, true]),
) as Record<keyof typeof REVIEW_FEATURES, boolean>;

function normalizeVersion(value: unknown) {
  return String(value || '').trim().replace(/^v(?=\d)/i, '');
}

@Injectable()
export class MiniRuntimeService {
  private configCache: any = null;
  private configCachedAt = 0;

  constructor(private readonly systemConfigService: SystemConfigService) {}

  private async getRuntimeConfig() {
    const now = Date.now();
    if (this.configCache && now - this.configCachedAt < 3000) return this.configCache;
    this.configCache = await this.systemConfigService.getMiniappCustomerServiceConfig();
    this.configCachedAt = now;
    return this.configCache;
  }

  readClient(headers: Record<string, any>) {
    return {
      appId: String(headers?.['x-miniapp-appid'] || '').trim(),
      version: normalizeVersion(headers?.['x-miniapp-version']),
      build: String(headers?.['x-miniapp-build'] || '').trim(),
      envVersion: String(headers?.['x-miniapp-env'] || '').trim().toLowerCase(),
      clientRevision: Math.max(0, Number(headers?.['x-miniapp-config-revision'] || 0) || 0),
    };
  }

  async resolve(headers: Record<string, any>) {
    const client = this.readClient(headers);
    const config: any = await this.getRuntimeConfig();
    const targets = (Array.isArray(config?.wechatReviewVersions) ? config.wechatReviewVersions : [])
      .map(normalizeVersion)
      .filter(Boolean);
    const reviewEnabled = !!config?.wechatReviewMode;
    const isRelease = client.envVersion === 'release';
    const versionMatched = !targets.length || targets.includes(client.version);
    const mode: MiniRuntimeMode = reviewEnabled && !isRelease && versionMatched ? 'REVIEW' : 'NORMAL';
    const revision = Math.max(0, Number(config?.revision || 0) || 0);
    return {
      mode,
      revision,
      client,
      features: mode === 'REVIEW' ? { ...REVIEW_FEATURES } : { ...NORMAL_FEATURES },
    };
  }
}
