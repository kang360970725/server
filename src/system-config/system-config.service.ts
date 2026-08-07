import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { UpsertSystemConfigDto } from './dto/upsert-system-config.dto';
import { ProjectStatus, UserType } from '@prisma/client';

@Injectable()
export class SystemConfigService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeMiniappHomeConfig(config: any) {
    const normalized = {
      banners: [],
      hotSales: [],
      limitedBenefits: [],
      recommendedStaff: [],
      hotEvents: [],
      quickEntries: [],
      esportsGoods: [],
      ...(config || {}),
    } as any;

    const list = Array.isArray(normalized?.limitedBenefits) ? normalized.limitedBenefits : [];
    normalized.limitedBenefits = list.map((item: any) => {
      const row = { ...(item || {}) } as any;
      const longTermRaw = row?.isLongTerm;
      const durationText = String(row?.durationHours ?? '').trim();
      const durationHours = Number(row?.durationHours);
      const isLongTerm =
        longTermRaw === true ||
        String(longTermRaw ?? '').toLowerCase() === 'true' ||
        String(longTermRaw ?? '').toLowerCase() === '1' ||
        !durationText ||
        !Number.isFinite(durationHours) ||
        durationHours <= 0;

      row.isLongTerm = isLongTerm;
      if (isLongTerm) {
        row.durationHours = null;
      } else {
        row.durationHours = durationHours;
      }
      return row;
    });

    return normalized;
  }

  private async filterMiniappHomeProductTargets(config: any) {
    const normalized = this.normalizeMiniappHomeConfig(config);
    const sections = ['banners', 'hotSales', 'limitedBenefits', 'recommendedStaff', 'hotEvents', 'quickEntries', 'esportsGoods'];
    const productIds = new Set<number>();

    for (const section of sections) {
      const list = Array.isArray(normalized?.[section]) ? normalized[section] : [];
      for (const item of list) {
        if (String(item?.targetType || '').toLowerCase() !== 'product') continue;
        const productId = Number(item?.targetValue);
        if (Number.isFinite(productId) && productId > 0) productIds.add(productId);
      }
    }

    if (!productIds.size) return normalized;

    const visibleProjects = await this.prisma.gameProject.findMany({
      where: {
        id: { in: Array.from(productIds) },
        status: ProjectStatus.ACTIVE,
        showInMenuList: true,
      },
      select: { id: true },
    });

    const visibleSet = new Set(visibleProjects.map((item) => Number(item.id)));

    for (const section of sections) {
      const list = Array.isArray(normalized?.[section]) ? normalized[section] : [];
      normalized[section] = list.filter((item: any) => {
        if (String(item?.targetType || '').toLowerCase() !== 'product') return true;
        const productId = Number(item?.targetValue);
        return Number.isFinite(productId) && visibleSet.has(productId);
      });
    }

    return normalized;
  }

  async onModuleInit() {
    await this.ensureDefaults();
  }

  static readonly KEYS = {
    OFFLINE_FEE_RATE: 'offline_fee_rate',
    OFFLINE_FEE_MIN: 'offline_fee_min',
    OFFLINE_FEE_CAP: 'offline_fee_cap',
    OFFLINE_FEE_PARTIAL_MIN_PAY: 'offline_fee_partial_min_pay',
    APP_PUBLIC_BASE_URL: 'app_public_base_url',
    WECHAT_PAY_MCHID: 'wechat_pay_mchid',
    WECHAT_PAY_SERIAL_NO: 'wechat_pay_serial_no',
    WECHAT_PAY_PRIVATE_KEY: 'wechat_pay_private_key',
    WECHAT_PAY_API_V3_KEY: 'wechat_pay_api_v3_key',
    WECHAT_PAY_TEST_ENABLED: 'wechat_pay_test_enabled',
    WECHAT_PAY_TEST_WHITELIST: 'wechat_pay_test_whitelist',
    WECHAT_PAY_NOTIFY_URL: 'wechat_pay_notify_url',
    WECHAT_PAY_RECHARGE_NOTIFY_URL: 'wechat_pay_recharge_notify_url',
    WECHAT_MINI_APPID: 'wechat_mini_appid',
    WECHAT_MINI_APPSECRET: 'wechat_mini_appsecret',
    WECHAT_MINI_SUBSCRIBE_MESSAGE_TEMPLATES: 'wechat_mini_subscribe_message_templates',
    COS_SECRET_ID: 'cos_secret_id',
    COS_SECRET_KEY: 'cos_secret_key',
    COS_BUCKET: 'cos_bucket',
    COS_REGION: 'cos_region',
    COS_CDN_DOMAIN: 'cos_cdn_domain',
    ORDER_SOURCE_OPTIONS: 'order_source_options',
    ORDER_RENEWAL_BONUS_RULES: 'order_renewal_bonus_rules',
    MINIAPP_HOME_CONFIG: 'miniapp_home_config',
    MINIAPP_HOME_CONFIG_DRAFT: 'miniapp_home_config_draft',
    MINIAPP_HOME_CONFIG_PUBLISHED: 'miniapp_home_config_published',
    MINIAPP_PROTOCOLS: 'miniapp_protocols',
    GOODS_CATEGORY_TREE: 'goods_category_tree',
    GOODS_TAG_LIST: 'goods_tag_list',
    STAFF_RULE_ENGINE_V1: 'staff_rule_engine_v1',
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
      {
        key: SystemConfigService.KEYS.APP_PUBLIC_BASE_URL,
        value: String(process.env.APP_PUBLIC_BASE_URL || '').trim(),
        valueType: 'STRING',
        remark: '公网访问域名，例如 https://example.com',
      },
      {
        key: SystemConfigService.KEYS.WECHAT_PAY_MCHID,
        value: String(process.env.WECHAT_PAY_MCHID || '').trim(),
        valueType: 'STRING',
        remark: '微信支付商户号',
      },
      {
        key: SystemConfigService.KEYS.WECHAT_PAY_SERIAL_NO,
        value: String(process.env.WECHAT_PAY_SERIAL_NO || '').trim(),
        valueType: 'STRING',
        remark: '微信支付商户证书序列号',
      },
      {
        key: SystemConfigService.KEYS.WECHAT_PAY_PRIVATE_KEY,
        value: String(process.env.WECHAT_PAY_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        valueType: 'STRING',
        remark: '微信支付商户 API 私钥',
      },
      {
        key: SystemConfigService.KEYS.WECHAT_PAY_API_V3_KEY,
        value: String(process.env.WECHAT_PAY_API_V3_KEY || '').trim(),
        valueType: 'STRING',
        remark: '微信支付 API v3 密钥',
      },
      {
        key: SystemConfigService.KEYS.WECHAT_PAY_TEST_ENABLED,
        value: 'false',
        valueType: 'BOOLEAN',
        remark: '是否允许白名单账号启用测试支付（0.01元）',
      },
      {
        key: SystemConfigService.KEYS.WECHAT_PAY_TEST_WHITELIST,
        value: JSON.stringify({
          userIds: [],
          phones: [],
          openIds: [],
          unionIds: [],
        }, null, 2),
        valueType: 'JSON',
        remark: '测试支付白名单，支持 userIds / phones / openIds / unionIds',
      },
      {
        key: SystemConfigService.KEYS.WECHAT_PAY_NOTIFY_URL,
        value: String(process.env.WECHAT_PAY_NOTIFY_URL || '').trim(),
        valueType: 'STRING',
        remark: '微信订单支付回调地址',
      },
      {
        key: SystemConfigService.KEYS.WECHAT_PAY_RECHARGE_NOTIFY_URL,
        value: String(process.env.WECHAT_PAY_RECHARGE_NOTIFY_URL || '').trim(),
        valueType: 'STRING',
        remark: '微信会员充值回调地址',
      },
      {
        key: SystemConfigService.KEYS.WECHAT_MINI_APPID,
        value: String(process.env.WECHAT_MINI_APPID || process.env.WECHAT_PAY_APPID || '').trim(),
        valueType: 'STRING',
        remark: '微信小程序 AppID',
      },
      {
        key: SystemConfigService.KEYS.WECHAT_MINI_APPSECRET,
        value: String(process.env.WECHAT_MINI_APPSECRET || '').trim(),
        valueType: 'STRING',
        remark: '微信小程序 AppSecret',
      },
      {
        key: SystemConfigService.KEYS.WECHAT_MINI_SUBSCRIBE_MESSAGE_TEMPLATES,
        value: JSON.stringify({
          orderProgress: {
            enabled: false,
            title: '订单进度提醒',
            description: '用于提醒订单创建、派单、接单、完成、退款等进度变化',
            templateId: '',
            page: '/pages/order-details/index',
            fields: {
              orderNo: 'character_string1',
              projectName: 'thing2',
              status: 'thing3',
              updatedAt: 'time4',
              remark: 'thing5',
            },
          },
          memberAsset: {
            enabled: false,
            title: '会员资产变动提醒',
            description: '用于提醒积分到账、成长值变动、退款回退等会员资产变化',
            templateId: '',
            page: '/pages/membership/index',
            fields: {
              assetType: 'thing1',
              changeAmount: 'thing2',
              balanceAfter: 'thing3',
              updatedAt: 'time4',
              remark: 'thing5',
            },
          },
          afterSalesResult: {
            enabled: false,
            title: '售后/退款处理结果提醒',
            description: '用于提醒售后审核通过、审核驳回、退款完成等结果',
            templateId: '',
            page: '/pages/after-sales/index',
            fields: {
              orderNo: 'character_string1',
              result: 'thing2',
              refundAmount: 'amount3',
              reviewedAt: 'time4',
              remark: 'thing5',
            },
          },
          marketingActivity: {
            enabled: false,
            title: '新玩法活动通知',
            description: '用于通知新玩法上新、活动开售、福利提醒',
            templateId: '',
            page: '/pages/index/index',
            fields: {
              activityName: 'thing1',
              startAt: 'time2',
              benefit: 'thing3',
              remark: 'thing4',
            },
          },
        }, null, 2),
        valueType: 'JSON',
        remark: '微信小程序订阅消息模板配置',
      },
      {
        key: SystemConfigService.KEYS.COS_SECRET_ID,
        value: String(process.env.COS_SECRET_ID || process.env.COS_STS_SECRET_ID || '').trim(),
        valueType: 'STRING',
        remark: '腾讯云 COS SecretId',
      },
      {
        key: SystemConfigService.KEYS.COS_SECRET_KEY,
        value: String(process.env.COS_SECRET_KEY || process.env.COS_STS_SECRET_KEY || '').trim(),
        valueType: 'STRING',
        remark: '腾讯云 COS SecretKey',
      },
      {
        key: SystemConfigService.KEYS.COS_BUCKET,
        value: String(process.env.COS_BUCKET || process.env.COS_UPLOAD_BUCKET || 'bluecat-pw-1393974512').trim(),
        valueType: 'STRING',
        remark: '腾讯云 COS Bucket',
      },
      {
        key: SystemConfigService.KEYS.COS_REGION,
        value: String(process.env.COS_REGION || process.env.COS_UPLOAD_REGION || 'ap-shanghai').trim(),
        valueType: 'STRING',
        remark: '腾讯云 COS 地域',
      },
      {
        key: SystemConfigService.KEYS.COS_CDN_DOMAIN,
        value: String(process.env.COS_CDN_DOMAIN || process.env.COS_UPLOAD_CDN_DOMAIN || '').trim(),
        valueType: 'STRING',
        remark: '腾讯云 COS CDN 域名（可选）',
      },
      {
        key: SystemConfigService.KEYS.ORDER_SOURCE_OPTIONS,
        value: JSON.stringify([
          { value: 'TUTU_PLATFORM', label: '突突平台', enabled: true },
          { value: 'THIRD_PARTY_TRANSFER', label: '第三方转单', enabled: true },
          { value: 'MINIAPP_SELF_SERVICE', label: '小程序自助下单', enabled: true },
          { value: 'CUSTOMER_SERVICE_MANUAL', label: '客服手动派单', enabled: true },
          { value: 'OFFICIAL_ACCOUNT', label: '公众号下单', enabled: true },
        ], null, 2),
        valueType: 'JSON',
        remark: '订单渠道来源选项',
      },
      {
        key: SystemConfigService.KEYS.ORDER_RENEWAL_BONUS_RULES,
        value: JSON.stringify({
          enabled: true,
          baseAmountField: 'paidAmount',
          tiers: [
            { min: 0, max: 300, rate: 0.01 },
            { min: 300.01, max: null, rate: 0.02 },
          ],
        }, null, 2),
        valueType: 'JSON',
        remark: '续单额外分红配置；配置失效时兜底为实付<=300按1%，>300按2%',
      },
      {
        key: SystemConfigService.KEYS.MINIAPP_HOME_CONFIG,
        value: JSON.stringify({
          banners: [],
          hotSales: [],
          limitedBenefits: [],
          recommendedStaff: [],
          hotEvents: [],
          quickEntries: [],
          esportsGoods: [],
        }),
        valueType: 'JSON',
        remark: '小程序首页配置（单配置模型）',
      },
      {
        key: SystemConfigService.KEYS.MINIAPP_HOME_CONFIG_DRAFT,
        value: JSON.stringify({
          banners: [],
          hotSales: [],
          limitedBenefits: [],
          recommendedStaff: [],
          hotEvents: [],
          quickEntries: [],
          esportsGoods: [],
        }),
        valueType: 'JSON',
        remark: '小程序首页配置草稿',
      },
      {
        key: SystemConfigService.KEYS.MINIAPP_HOME_CONFIG_PUBLISHED,
        value: JSON.stringify({
          banners: [],
          hotSales: [],
          limitedBenefits: [],
          recommendedStaff: [],
          hotEvents: [],
          quickEntries: [],
          esportsGoods: [],
        }),
        valueType: 'JSON',
        remark: '小程序首页配置发布版',
      },
      {
        key: SystemConfigService.KEYS.MINIAPP_PROTOCOLS,
        value: JSON.stringify([
          {
            key: 'platform_user_service_agreement',
            title: '平台用户服务协议',
            coverImage: '',
            content: '<p>请编辑平台用户服务协议内容。</p>',
            enabled: false,
            sort: 10,
            remark: '整合原用户协议、平台服务协议、会员注册协议',
          },
          {
            key: 'member_service_agreement',
            title: '会员服务协议',
            coverImage: '',
            content: '<p>请编辑会员服务协议内容。</p>',
            enabled: false,
            sort: 20,
            remark: '付费会员专属协议',
          },
          {
            key: 'privacy_policy_cookie',
            title: '隐私政策 + Cookie 使用说明',
            coverImage: '',
            content: '<p>请编辑隐私政策与 Cookie 使用说明。</p>',
            enabled: false,
            sort: 30,
            remark: '隐私政策与 Cookie 使用说明',
          },
          {
            key: 'minor_protection_rules',
            title: '未成年人保护专项规则',
            coverImage: '',
            content: '<p>请编辑未成年人保护专项规则。</p>',
            enabled: false,
            sort: 40,
            remark: '未成年人保护专项规则',
          },
          {
            key: 'order_service_agreement',
            title: '下单服务协议',
            coverImage: '',
            content: '<p>请编辑下单服务协议内容。</p>',
            enabled: false,
            sort: 50,
            remark: '用户下单前勾选的服务协议',
          },
          {
            key: 'after_sales_service_agreement',
            title: '售后服务协议',
            coverImage: '',
            content: '<p>请编辑售后服务协议内容。</p>',
            enabled: false,
            sort: 60,
            remark: '售后服务说明',
          },
          {
            key: 'wallet_service_agreement',
            title: '平台钱包服务协议',
            coverImage: '',
            content: '<p>请编辑平台钱包服务协议内容。</p>',
            enabled: false,
            sort: 70,
            remark: '钱包账户服务说明',
          },
          {
            key: 'recharge_service_agreement',
            title: '充值服务协议、预付储值须知',
            coverImage: '',
            content: '<p>请编辑充值服务协议与预付储值须知。</p>',
            enabled: false,
            sort: 80,
            remark: '充值及预付储值说明',
          },
          {
            key: 'passwordless_payment_authorization',
            title: '免密支付 / 快捷扣款授权协议',
            coverImage: '',
            content: '<p>请编辑免密支付或快捷扣款授权协议。</p>',
            enabled: false,
            sort: 90,
            remark: '免密支付/快捷扣款授权',
          },
          {
            key: 'merchant_entry_cooperation_agreement',
            title: '商户入驻合作协议',
            coverImage: '',
            content: '<p>请编辑商户入驻合作协议。</p>',
            enabled: false,
            sort: 100,
            remark: 'B端商户入驻签约',
          },
          {
            key: 'merchant_settlement_agreement',
            title: '商户结算协议',
            coverImage: '',
            content: '<p>请编辑商户结算协议。</p>',
            enabled: false,
            sort: 110,
            remark: 'B端商户结算条款',
          },
          {
            key: 'merchant_deposit_agreement',
            title: '商户保证金协议',
            coverImage: '',
            content: '<p>请编辑商户保证金协议。</p>',
            enabled: false,
            sort: 120,
            remark: 'B端商户保证金条款',
          },
          {
            key: 'product_service_publish_rules',
            title: '商品 / 服务发布管理规范',
            coverImage: '',
            content: '<p>请编辑商品或服务发布管理规范。</p>',
            enabled: false,
            sort: 130,
            remark: '商品/服务发布规范',
          },
          {
            key: 'platform_advertising_cooperation_agreement',
            title: '平台广告投放协议（商家投流）',
            coverImage: '',
            content: '<p>请编辑平台广告投放协议。</p>',
            enabled: false,
            sort: 140,
            remark: '商家投流合作协议',
          },
          {
            key: 'revenue_sharing_service_agreement',
            title: '分账服务协议',
            coverImage: '',
            content: '<p>请编辑分账服务协议。</p>',
            enabled: false,
            sort: 150,
            remark: '平台对外合作协议',
          },
          {
            key: 'third_party_payment_cooperation_agreement',
            title: '第三方支付合作协议',
            coverImage: '',
            content: '<p>请编辑第三方支付合作协议。</p>',
            enabled: false,
            sort: 160,
            remark: '平台对外合作协议',
          },
          {
            key: 'electronic_signature_usage_agreement',
            title: '电子签章使用协议',
            coverImage: '',
            content: '<p>请编辑电子签章使用协议。</p>',
            enabled: false,
            sort: 170,
            remark: '平台对外合作协议',
          },
          {
            key: 'marketing_activity_cooperation_agreement',
            title: '营销活动合作协议',
            coverImage: '',
            content: '<p>请编辑营销活动合作协议。</p>',
            enabled: false,
            sort: 180,
            remark: '优惠券、拼团、平台活动等合作协议',
          },
        ], null, 2),
        valueType: 'JSON',
        remark: '小程序协议维护列表',
      },
      {
        key: SystemConfigService.KEYS.GOODS_CATEGORY_TREE,
        value: JSON.stringify([]),
        valueType: 'JSON',
        remark: '商品分类树（支持三级）',
      },
      {
        key: SystemConfigService.KEYS.GOODS_TAG_LIST,
        value: JSON.stringify([]),
        valueType: 'JSON',
        remark: '商品标签列表（按一级分类绑定）',
      },
      {
        key: SystemConfigService.KEYS.STAFF_RULE_ENGINE_V1,
        value: JSON.stringify({ tags: [], rules: [] }, null, 2),
        valueType: 'JSON',
        remark: '员工规则分组与提现/退店规则配置',
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

  async getString(key: string, fallback = '') {
    const row = await this.getRawByKey(key);
    if (!row || !row.enabled) return String(fallback || '').trim();
    return String(row.value || '').trim() || String(fallback || '').trim();
  }

  async getBoolean(key: string, fallback = false) {
    const row = await this.getRawByKey(key);
    if (!row || !row.enabled) return !!fallback;
    const value = String(row.value || '').trim().toLowerCase();
    if (!value) return !!fallback;
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return !!fallback;
  }

  async getJson<T = any>(key: string, fallback: T): Promise<T> {
    const row = await this.getRawByKey(key);
    if (!row || !row.enabled || !row.value) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  async getMiniappHomeConfig() {
    const fallback = {
      banners: [],
      hotSales: [],
      limitedBenefits: [],
      recommendedStaff: [],
      hotEvents: [],
      quickEntries: [],
      esportsGoods: [],
    };
    return this.getJson(SystemConfigService.KEYS.MINIAPP_HOME_CONFIG_DRAFT, fallback);
  }

  async getOrderSourceOptions() {
    const fallback = [
      { value: 'TUTU_PLATFORM', label: '突突平台', enabled: true },
      { value: 'THIRD_PARTY_TRANSFER', label: '第三方转单', enabled: true },
      { value: 'MINIAPP_SELF_SERVICE', label: '小程序自助下单', enabled: true },
      { value: 'CUSTOMER_SERVICE_MANUAL', label: '客服手动派单', enabled: true },
      { value: 'OFFICIAL_ACCOUNT', label: '公众号下单', enabled: true },
    ];
    const raw = await this.getJson<any[]>(SystemConfigService.KEYS.ORDER_SOURCE_OPTIONS, fallback);
    const list = Array.isArray(raw) ? raw : fallback;
    return list
      .map((item: any) => ({
        value: String(item?.value || '').trim(),
        label: String(item?.label || item?.value || '').trim(),
        enabled: item?.enabled !== false,
      }))
      .filter((item) => item.value && item.label);
  }

  async getEnabledOrderSourceOptions() {
    const list = await this.getOrderSourceOptions();
    return list.filter((item) => item.enabled !== false);
  }

  async getCosUploadConfig() {
    const [secretId, secretKey, bucket, region, cdnDomain] = await Promise.all([
      this.getString(SystemConfigService.KEYS.COS_SECRET_ID, process.env.COS_SECRET_ID || process.env.COS_STS_SECRET_ID || ''),
      this.getString(SystemConfigService.KEYS.COS_SECRET_KEY, process.env.COS_SECRET_KEY || process.env.COS_STS_SECRET_KEY || ''),
      this.getString(SystemConfigService.KEYS.COS_BUCKET, process.env.COS_BUCKET || process.env.COS_UPLOAD_BUCKET || 'bluecat-pw-1393974512'),
      this.getString(SystemConfigService.KEYS.COS_REGION, process.env.COS_REGION || process.env.COS_UPLOAD_REGION || 'ap-shanghai'),
      this.getString(SystemConfigService.KEYS.COS_CDN_DOMAIN, process.env.COS_CDN_DOMAIN || process.env.COS_UPLOAD_CDN_DOMAIN || ''),
    ]);
    return {
      secretId: String(secretId || '').trim(),
      secretKey: String(secretKey || '').trim(),
      bucket: String(bucket || '').trim(),
      region: String(region || '').trim(),
      cdnDomain: String(cdnDomain || '').trim(),
    };
  }

  async upsertMiniappHomeConfig(config: any) {
    const normalized = this.normalizeMiniappHomeConfig(config);
    return this.prisma.systemConfig.upsert({
      where: { key: SystemConfigService.KEYS.MINIAPP_HOME_CONFIG_DRAFT },
      update: {
        value: JSON.stringify(normalized || {}),
        valueType: 'JSON',
        enabled: true,
        remark: '小程序首页配置草稿',
      },
      create: {
        key: SystemConfigService.KEYS.MINIAPP_HOME_CONFIG_DRAFT,
        value: JSON.stringify(normalized || {}),
        valueType: 'JSON',
        enabled: true,
        remark: '小程序首页配置草稿',
      },
    });
  }

  async getMiniappHomePublishedConfig() {
    const fallback = {
      banners: [],
      hotSales: [],
      limitedBenefits: [],
      recommendedStaff: [],
      hotEvents: [],
      quickEntries: [],
      esportsGoods: [],
    };
    const config = await this.getJson(SystemConfigService.KEYS.MINIAPP_HOME_CONFIG_PUBLISHED, fallback);
    return this.filterMiniappHomeProductTargets(config);
  }

  async publishMiniappHomeConfig() {
    const draft = await this.getMiniappHomeConfig();
    await this.prisma.systemConfig.upsert({
      where: { key: SystemConfigService.KEYS.MINIAPP_HOME_CONFIG_PUBLISHED },
      update: {
        value: JSON.stringify(draft || {}),
        valueType: 'JSON',
        enabled: true,
        remark: '小程序首页配置发布版',
      },
      create: {
        key: SystemConfigService.KEYS.MINIAPP_HOME_CONFIG_PUBLISHED,
        value: JSON.stringify(draft || {}),
        valueType: 'JSON',
        enabled: true,
        remark: '小程序首页配置发布版',
      },
    });
    // 兼容旧 key（避免已有调用受影响）
    await this.prisma.systemConfig.upsert({
      where: { key: SystemConfigService.KEYS.MINIAPP_HOME_CONFIG },
      update: {
        value: JSON.stringify(draft || {}),
        valueType: 'JSON',
        enabled: true,
        remark: '小程序首页配置（兼容键）',
      },
      create: {
        key: SystemConfigService.KEYS.MINIAPP_HOME_CONFIG,
        value: JSON.stringify(draft || {}),
        valueType: 'JSON',
        enabled: true,
        remark: '小程序首页配置（兼容键）',
      },
    });
    return { success: true };
  }

  async listHomeStaffCandidates(keyword?: string) {
    const k = (keyword || '').trim();
    return this.prisma.user.findMany({
      where: {
        userType: UserType.STAFF,
        ...(k
          ? {
              OR: [{ name: { contains: k } }, { phone: { contains: k } }],
            }
          : {}),
        Role: {
          permissions: {
            some: {
              key: 'staff:my-orders:page',
            },
          },
        },
      },
      select: {
        id: true,
        name: true,
        phone: true,
        avatar: true,
        rating: true,
        workStatus: true,
        staffRating: {
          select: { name: true },
        },
      },
      take: 200,
      orderBy: { id: 'desc' },
    });
  }

  async listHomeProductCandidates(keyword?: string) {
    const k = (keyword || '').trim();
    return this.prisma.gameProject.findMany({
      where: {
        status: 'ACTIVE',
        ...(k
          ? {
              name: { contains: k },
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        price: true,
        coverImage: true,
        description: true,
        category: true,
        projectType: true,
        gameType: true,
      },
      take: 200,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
  }

  async getGoodsCategoryTree() {
    return this.getJson(SystemConfigService.KEYS.GOODS_CATEGORY_TREE, []);
  }

  async upsertGoodsCategoryTree(tree: any[]) {
    const safe = Array.isArray(tree) ? tree : [];
    return this.prisma.systemConfig.upsert({
      where: { key: SystemConfigService.KEYS.GOODS_CATEGORY_TREE },
      update: {
        value: JSON.stringify(safe),
        valueType: 'JSON',
        enabled: true,
        remark: '商品分类树（支持三级）',
      },
      create: {
        key: SystemConfigService.KEYS.GOODS_CATEGORY_TREE,
        value: JSON.stringify(safe),
        valueType: 'JSON',
        enabled: true,
        remark: '商品分类树（支持三级）',
      },
    });
  }

  async getGoodsTagList() {
    return this.getJson(SystemConfigService.KEYS.GOODS_TAG_LIST, []);
  }

  async upsertGoodsTagList(tags: any[]) {
    const safe = Array.isArray(tags) ? tags : [];
    return this.prisma.systemConfig.upsert({
      where: { key: SystemConfigService.KEYS.GOODS_TAG_LIST },
      update: {
        value: JSON.stringify(safe),
        valueType: 'JSON',
        enabled: true,
        remark: '商品标签列表（按一级分类绑定）',
      },
      create: {
        key: SystemConfigService.KEYS.GOODS_TAG_LIST,
        value: JSON.stringify(safe),
        valueType: 'JSON',
        enabled: true,
        remark: '商品标签列表（按一级分类绑定）',
      },
    });
  }
}
