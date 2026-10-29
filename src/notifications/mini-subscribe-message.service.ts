import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { NotificationType, WechatBindingPlatform } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';

type TemplateCode = 'ORDER_PROGRESS' | 'MEMBER_ASSET' | 'AFTER_SALES_RESULT' | 'MARKETING_ACTIVITY';
type SubscribeScene = 'ORDER_PLACE' | 'AFTER_SALES_APPLY' | 'MARKETING_DETAIL';

type TemplateFieldMap = {
  orderNo?: string;
  projectName?: string;
  status?: string;
  updatedAt?: string;
  remark?: string;
  assetType?: string;
  changeAmount?: string;
  balanceAfter?: string;
  growthValue?: string;
  points?: string;
  result?: string;
  refundAmount?: string;
  reviewedAt?: string;
  activityName?: string;
  startAt?: string;
  benefit?: string;
};

type TemplateConfig = {
  enabled: boolean;
  title: string;
  description: string;
  templateId: string;
  page: string;
  fields: TemplateFieldMap;
};

type TemplateConfigMap = {
  orderProgress: TemplateConfig;
  memberAsset: TemplateConfig;
  afterSalesResult: TemplateConfig;
  marketingActivity: TemplateConfig;
};

@Injectable()
export class MiniSubscribeMessageService {
  private readonly logger = new Logger(MiniSubscribeMessageService.name);
  private accessTokenCache: { value: string; expiresAt: number } | null = null;

  private isWechatCloudRun() {
    return String(process.env.NODE_ENV || '').toLowerCase() === 'production'
      && Boolean(String(process.env.TCB_ENV_ID || '').trim());
  }

  private getWechatApiBaseUrl() {
    const configured = String(process.env.WECHAT_API_BASE_URL || '').trim().replace(/\/$/, '');
    if (configured) {
      const parsed = new URL(configured);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname !== 'api.weixin.qq.com') {
        throw new Error('WECHAT_API_BASE_URL 必须指向 api.weixin.qq.com');
      }
      return configured;
    }
    return this.isWechatCloudRun() ? 'http://api.weixin.qq.com' : 'https://api.weixin.qq.com';
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async assertMiniTextSafe(userId: number, contentInput: unknown) {
    const content = String(contentInput || '').trim();
    if (!content) return;

    // 本地高置信度兜底；生产环境同时使用微信内容安全接口进行语义审核。
    const compact = content.toLowerCase().replace(/[\s\-_.*·，。！？、]/g, '');
    const blockedPatterns = [
      /代开.*发票|出售.*银行卡|收购.*银行卡|买卖.*身份证/,
      /博彩|赌球|地下钱庄|洗钱|枪支弹药|毒品交易/,
      /成人视频|色情服务|招嫖|卖淫|嫖娼/,
      /恐怖袭击|制作炸弹|煽动颠覆/,
    ];
    if (blockedPatterns.some((pattern) => pattern.test(compact))) {
      throw new BadRequestException('提交内容包含不适宜信息，请修改后重试');
    }

    try {
      const binding = await this.prisma.userWechatBinding.findFirst({
        where: { userId, platform: 'MINIAPP' },
        orderBy: { updatedAt: 'desc' },
        select: { openId: true },
      });
      if (!binding?.openId) return;
      const accessToken = await this.getMiniAccessToken();
      const requestQuery = accessToken ? `?access_token=${encodeURIComponent(accessToken)}` : '';
      const response = await fetch(`${this.getWechatApiBaseUrl()}/wxa/msg_sec_check${requestQuery}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, version: 2, scene: 2, openid: binding.openId }),
      });
      const result: any = await response.json();
      const suggest = String(result?.result?.suggest || '').toLowerCase();
      if (suggest === 'risky' || suggest === 'review') {
        throw new BadRequestException('提交内容未通过安全审核，请修改后重试');
      }
      if (!response.ok || (Number(result?.errcode || 0) !== 0 && Number(result?.errcode || 0) !== 87014)) {
        this.logger.warn(`微信文本安全检查异常 user=${userId}: ${result?.errmsg || response.status}`);
      }
      if (Number(result?.errcode || 0) === 87014) {
        throw new BadRequestException('提交内容未通过安全审核，请修改后重试');
      }
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      // 审核服务临时不可用时保留本地高置信度规则，避免阻断正常反馈。
      this.logger.warn(`微信文本安全检查失败 user=${userId}: ${error?.message || error}`);
    }
  }

  private getDefaultConfig(): TemplateConfigMap {
    return {
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
        description: '用于提醒积分到账、退款回退和钱包资产变化',
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
    };
  }

  private normalizeFieldMap(input: any, fallback: TemplateFieldMap): TemplateFieldMap {
    const merged = { ...(fallback || {}), ...(input && typeof input === 'object' ? input : {}) } as Record<string, any>;
    return Object.keys(merged).reduce((acc, key) => {
      const value = String(merged[key] || '').trim();
      if (value) acc[key as keyof TemplateFieldMap] = value;
      return acc;
    }, {} as TemplateFieldMap);
  }

  private normalizeTemplateConfig(input: any, fallback: TemplateConfig): TemplateConfig {
    const row = input && typeof input === 'object' ? input : {};
    return {
      enabled: row.enabled === true || String(row.enabled || '').toLowerCase() === 'true',
      title: String(row.title || fallback.title).trim(),
      description: String(row.description || fallback.description).trim(),
      templateId: String(row.templateId || '').trim(),
      page: String(row.page || fallback.page).trim() || fallback.page,
      fields: this.normalizeFieldMap(row.fields, fallback.fields),
    };
  }

  async getTemplateConfigMap() {
    const fallback = this.getDefaultConfig();
    const raw = await this.systemConfigService.getJson<any>(
      SystemConfigService.KEYS.WECHAT_MINI_SUBSCRIBE_MESSAGE_TEMPLATES,
      fallback,
    );
    return {
      orderProgress: this.normalizeTemplateConfig(raw?.orderProgress, fallback.orderProgress),
      memberAsset: this.normalizeTemplateConfig(raw?.memberAsset, fallback.memberAsset),
      afterSalesResult: this.normalizeTemplateConfig(raw?.afterSalesResult, fallback.afterSalesResult),
      marketingActivity: this.normalizeTemplateConfig(raw?.marketingActivity, fallback.marketingActivity),
    };
  }

  async getTemplateOptionsByScene(scene: SubscribeScene) {
    const config = await this.getTemplateConfigMap();
    const sceneItems: Record<SubscribeScene, Array<{ code: TemplateCode; value: TemplateConfig }>> = {
      ORDER_PLACE: [
        { code: 'ORDER_PROGRESS', value: config.orderProgress },
        { code: 'MEMBER_ASSET', value: config.memberAsset },
      ],
      AFTER_SALES_APPLY: [
        { code: 'AFTER_SALES_RESULT', value: config.afterSalesResult },
      ],
      MARKETING_DETAIL: [
        { code: 'MARKETING_ACTIVITY', value: config.marketingActivity },
      ],
    };
    const items = sceneItems[scene] || [];
    return items
      .filter((item) => item.value.enabled && item.value.templateId)
      .map((item) => ({
        code: item.code,
        title: item.value.title,
        description: item.value.description,
        templateId: item.value.templateId,
      }));
  }

  async recordSubscribeRequest(userId: number, payload: any) {
    const scene = String(payload?.scene || '').trim() || 'UNKNOWN';
    const event = String(payload?.event || '').trim() || 'UNKNOWN';
    const errMsg = String(payload?.errMsg || '').trim() || null;
    const templateResults = (Array.isArray(payload?.templateResults) ? payload.templateResults : [])
      .map((item: any) => ({
        code: String(item?.code || '').trim(),
        title: String(item?.title || '').trim(),
        templateId: String(item?.templateId || '').trim(),
        result: String(item?.result || '').trim(),
      }))
      .filter((item) => item.code && item.templateId);

    await this.prisma.userLog.create({
      data: {
        userId,
        action: 'MINI_SUBSCRIBE_MESSAGE_REQUEST',
        targetType: 'WECHAT_SUBSCRIBE_MESSAGE',
        newData: {
          scene,
          event,
          errMsg,
          templateResults,
        } as any,
        remark: `mini subscribe message ${event.toLowerCase()}`,
      },
    });
    return { success: true };
  }

  private async getMiniAccessToken() {
    if (this.isWechatCloudRun()) return '';

    const now = Date.now();
    if (this.accessTokenCache && this.accessTokenCache.expiresAt > now + 60_000) {
      return this.accessTokenCache.value;
    }

    const [appId, appSecret] = await Promise.all([
      this.systemConfigService.getString(
        SystemConfigService.KEYS.WECHAT_MINI_APPID,
        String(process.env.WECHAT_MINI_APPID || process.env.WECHAT_PAY_APPID || '').trim(),
      ),
      this.systemConfigService.getString(
        SystemConfigService.KEYS.WECHAT_MINI_APPSECRET,
        String(process.env.WECHAT_MINI_APPSECRET || '').trim(),
      ),
    ]);

    if (!appId || !appSecret) {
      throw new Error('缺少微信小程序 AppID / AppSecret，无法发送订阅消息');
    }

    const tokenResp = await fetch(
      `${this.getWechatApiBaseUrl()}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}`,
    );
    const tokenData: any = await tokenResp.json();
    const accessToken = String(tokenData?.access_token || '').trim();
    if (!accessToken) {
      throw new Error(String(tokenData?.errmsg || '获取微信 access_token 失败'));
    }

    const expiresInSeconds = Math.max(300, Number(tokenData?.expires_in || 7200));
    this.accessTokenCache = {
      value: accessToken,
      expiresAt: now + expiresInSeconds * 1000,
    };
    return accessToken;
  }

  private formatDateTime(input?: Date | string | null) {
    const date = input ? new Date(input) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    const y = date.getFullYear();
    const m = `${date.getMonth() + 1}`.padStart(2, '0');
    const d = `${date.getDate()}`.padStart(2, '0');
    const hh = `${date.getHours()}`.padStart(2, '0');
    const mm = `${date.getMinutes()}`.padStart(2, '0');
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }

  private formatAmount(value: any) {
    const amount = Number(value || 0);
    return Number.isFinite(amount) ? `¥${amount.toFixed(2)}` : '¥0.00';
  }

  private normalizeTemplateValue(fieldKey: string, value: any) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    // 微信的 date 类型只接受日期；业务层统一传入的时间值需要在这里去掉时分。
    if (fieldKey.startsWith('date')) {
      const matchedDate = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
      return matchedDate || text.slice(0, 10);
    }
    if (fieldKey.startsWith('thing')) return text.slice(0, 20);
    if (fieldKey.startsWith('phrase')) return text.slice(0, 5);
    if (fieldKey.startsWith('name')) return text.slice(0, 10);
    if (fieldKey.startsWith('character_string')) return text.slice(0, 32);
    if (fieldKey.startsWith('amount')) return text.slice(0, 12);
    if (fieldKey.startsWith('phone_number')) return text.slice(0, 17);
    return text.slice(0, 64);
  }

  private buildTemplatePayload(fields: TemplateFieldMap, values: Record<string, any>) {
    const data: Record<string, { value: string }> = {};
    Object.entries(fields || {}).forEach(([semanticKey, templateKey]) => {
      const key = String(templateKey || '').trim();
      if (!key) return;
      const normalizedValue = this.normalizeTemplateValue(key, values[semanticKey]);
      if (!normalizedValue) return;
      data[key] = { value: normalizedValue };
    });
    return data;
  }

  private buildPagePath(page: string, query?: Record<string, any>) {
    // 微信订阅消息 page 参数要求使用小程序内部路径，不带开头的斜杠。
    const base = String(page || '').trim().replace(/^\/+/, '');
    if (!base) return '';
    const params = Object.entries(query || {})
      .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    if (!params.length) return base;
    return `${base}${base.includes('?') ? '&' : '?'}${params.join('&')}`;
  }

  async generateOrderClaimMiniCode(tokenInput: unknown) {
    const token = String(tokenInput || '').trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(token)) throw new Error('订单认领码格式无效');
    const accessToken = await this.getMiniAccessToken();
    const requestQuery = accessToken ? `?access_token=${encodeURIComponent(accessToken)}` : '';
    const response = await fetch(`${this.getWechatApiBaseUrl()}/wxa/getwxacodeunlimit${requestQuery}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        scene: token,
        page: 'pages/order-claim/index',
        check_path: false,
        env_version: String(process.env.WECHAT_MINI_CODE_ENV_VERSION || 'release'),
        width: 430,
        auto_color: false,
        line_color: {r: 245, g: 95, b: 139},
        is_hyaline: false,
      }),
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok || contentType.includes('application/json') || buffer.length < 100) {
      let detail = `微信小程序码生成失败（HTTP ${response.status}）`;
      try {
        const parsed = JSON.parse(buffer.toString('utf8'));
        detail = String(parsed?.errmsg || detail);
      } catch {}
      throw new Error(detail);
    }
    const mimeType = contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/jpeg';
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  private resolveOrderStatusText(status: string) {
    const current = String(status || '').trim().toUpperCase();
    const map: Record<string, string> = {
      WAIT_ASSIGN: '待派单',
      WAIT_ACCEPT: '待接单',
      ACCEPTED: '服务中',
      ARCHIVED: '服务中',
      COMPLETED_PENDING_CONFIRM: '待确认结单',
      COMPLETED: '待评价',
      WAIT_REVIEW: '待评价',
      REVIEWED: '已评价',
      WAIT_AFTERSALE: '售后处理中',
      AFTERSALE_DONE: '售后已处理',
      REFUNDED: '已退款',
      CANCELLED: '已取消',
    };
    return map[current] || current || '订单状态更新';
  }

  private async sendConfiguredMessage(params: {
    userId: number;
    code: TemplateCode;
    values: Record<string, any>;
    pageQuery?: Record<string, any>;
    targetType?: string;
    targetId?: number | null;
    remark?: string;
  }) {
    const configMap = await this.getTemplateConfigMap();
    const config = params.code === 'ORDER_PROGRESS'
      ? configMap.orderProgress
      : params.code === 'MEMBER_ASSET'
        ? configMap.memberAsset
        : params.code === 'AFTER_SALES_RESULT'
          ? configMap.afterSalesResult
      : params.code === 'MARKETING_ACTIVITY'
        ? configMap.marketingActivity
        : configMap.orderProgress;

    if (!config.enabled || !config.templateId) {
      return { success: false, skipped: 'config_disabled' };
    }

    const binding = await this.prisma.userWechatBinding.findFirst({
      where: {
        userId: Number(params.userId),
        platform: WechatBindingPlatform.MINIAPP,
      },
      orderBy: { id: 'desc' },
      select: {
        openId: true,
      },
    });
    const openId = String(binding?.openId || '').trim();
    if (!openId) {
      return { success: false, skipped: 'openid_missing' };
    }

    const page = this.buildPagePath(config.page, params.pageQuery);
    const data = this.buildTemplatePayload(config.fields, params.values);
    if (!Object.keys(data).length) {
      return { success: false, skipped: 'field_mapping_missing' };
    }

    try {
      const accessToken = await this.getMiniAccessToken();
      const query: string[] = [];
      if (accessToken) {
        query.push(`access_token=${encodeURIComponent(accessToken)}`);
      }
      const requestQuery = query.length ? `?${query.join('&')}` : '';
      const resp = await fetch(
        `${this.getWechatApiBaseUrl()}/cgi-bin/message/subscribe/send${requestQuery}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            touser: openId,
            template_id: config.templateId,
            page,
            data,
            lang: 'zh_CN',
          }),
        },
      );
      const responseData: any = await resp.json();
      const success = Number(responseData?.errcode || 0) === 0;

      await this.prisma.userLog.create({
        data: {
          userId: Number(params.userId),
          action: success ? 'MINI_SUBSCRIBE_MESSAGE_SEND_SUCCESS' : 'MINI_SUBSCRIBE_MESSAGE_SEND_FAILED',
          targetType: params.targetType || 'WECHAT_SUBSCRIBE_MESSAGE',
          targetId: params.targetId == null ? null : Number(params.targetId),
          newData: {
            code: params.code,
            templateId: config.templateId,
            page,
            data,
            response: responseData,
          } as any,
          remark: params.remark || `mini subscribe message ${params.code.toLowerCase()}`,
        },
      });

      return success
        ? { success: true }
        : { success: false, skipped: 'wechat_rejected', response: responseData };
    } catch (error: any) {
      this.logger.warn(`sendConfiguredMessage failed: ${error?.message || error}`);
      await this.prisma.userLog.create({
        data: {
          userId: Number(params.userId),
          action: 'MINI_SUBSCRIBE_MESSAGE_SEND_EXCEPTION',
          targetType: params.targetType || 'WECHAT_SUBSCRIBE_MESSAGE',
          targetId: params.targetId == null ? null : Number(params.targetId),
          newData: {
            code: params.code,
            error: String(error?.message || error || ''),
          } as any,
          remark: params.remark || `mini subscribe message ${params.code.toLowerCase()}`,
        },
      });
      return { success: false, skipped: 'exception', error: String(error?.message || error || '') };
    }
  }

  async pushOrderProgressMessage(orderId: number, remark?: string, explicitStatusText?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: Number(orderId) },
      select: {
        id: true,
        autoSerial: true,
        status: true,
        orderTime: true,
        createdAt: true,
        customerUserId: true,
        project: { select: { name: true } },
        projectSnapshot: true,
      },
    });
    if (!order?.customerUserId) return { success: false, skipped: 'customer_missing' };

    const snapshot = order.projectSnapshot && typeof order.projectSnapshot === 'object' ? (order.projectSnapshot as any) : {};
    const projectName = String(order?.project?.name || snapshot?.name || `订单#${order.id}`).trim();
    const statusText = String(explicitStatusText || this.resolveOrderStatusText(String(order.status || ''))).trim();
    const stationContent = String(remark || `订单当前状态：${statusText}`).trim();

    // 站内信不依赖微信订阅授权，始终作为订单进度通知的可靠兜底。
    const stationNotification = await this.prisma.userNotification.create({
      data: {
        userId: Number(order.customerUserId),
        type: NotificationType.ORDER_PROGRESS,
        title: `${statusText} · ${projectName}`.slice(0, 120),
        content: stationContent,
        payload: {
          orderId: Number(order.id),
          orderNo: order.autoSerial || null,
          status: String(order.status || ''),
          statusText,
          page: `/pages/order-details/index?id=${order.id}`,
        },
      },
    });

    const wechatResult = await this.sendConfiguredMessage({
      userId: Number(order.customerUserId),
      code: 'ORDER_PROGRESS',
      targetType: 'ORDER',
      targetId: Number(order.id),
      remark: 'mini order progress notify',
      pageQuery: { id: order.id },
      values: {
        orderNo: order.autoSerial,
        projectName,
        status: statusText,
        // 配置项沿用 updatedAt 这一语义键，但当前公共模板对应的是“下单时间”。
        updatedAt: this.formatDateTime(order.orderTime || order.createdAt),
        remark: stationContent,
      },
    });
    return { ...wechatResult, stationNotificationId: stationNotification.id };
  }

  async pushMemberAssetMessage(params: {
    userId: number;
    assetType: string;
    changeAmount: string;
    balanceAfter?: string;
    updatedAt?: Date | string | null;
    remark?: string;
    pageQuery?: Record<string, any>;
    targetType?: string;
    targetId?: number | null;
  }) {
    return this.sendConfiguredMessage({
      userId: Number(params.userId),
      code: 'MEMBER_ASSET',
      targetType: params.targetType || 'USER',
      targetId: params.targetId == null ? Number(params.userId) : Number(params.targetId),
      remark: 'mini member asset notify',
      pageQuery: params.pageQuery,
      values: {
        assetType: String(params.assetType || '').trim(),
        changeAmount: String(params.changeAmount || '').trim(),
        balanceAfter: String(params.balanceAfter || '').trim(),
        updatedAt: this.formatDateTime(params.updatedAt || new Date()),
        remark: String(params.remark || '').trim(),
      },
    });
  }

  async pushAfterSalesResultMessage(params: {
    userId: number;
    orderId: number;
    orderNo: string;
    result: string;
    refundAmount?: number;
    reviewedAt?: Date | string | null;
    remark?: string;
  }) {
    const stationNotification = await this.prisma.userNotification.create({
      data: {
        userId: Number(params.userId),
        type: NotificationType.ORDER_PROGRESS,
        title: `售后进度 · ${String(params.result || '处理结果')}`.slice(0, 120),
        content: String(params.remark || params.result || '售后状态已更新'),
        payload: {
          orderId: Number(params.orderId),
          orderNo: params.orderNo,
          statusText: params.result,
          page: `/pages/order-details/index?id=${params.orderId}`,
        },
      },
    });
    const wechatResult = await this.sendConfiguredMessage({
      userId: Number(params.userId),
      code: 'AFTER_SALES_RESULT',
      targetType: 'ORDER',
      targetId: Number(params.orderId),
      remark: 'mini after sales result notify',
      pageQuery: { id: params.orderId },
      values: {
        orderNo: params.orderNo,
        result: params.result,
        refundAmount: params.refundAmount == null ? '' : this.formatAmount(params.refundAmount),
        reviewedAt: this.formatDateTime(params.reviewedAt || new Date()),
        remark: String(params.remark || '').trim(),
      },
    });
    return { ...wechatResult, stationNotificationId: stationNotification.id };
  }

  async pushMarketingActivityMessage(params: {
    userId: number;
    activityName: string;
    startAt?: Date | string | null;
    benefit?: string;
    remark?: string;
    pageQuery?: Record<string, any>;
  }) {
    return this.sendConfiguredMessage({
      userId: Number(params.userId),
      code: 'MARKETING_ACTIVITY',
      targetType: 'USER',
      targetId: Number(params.userId),
      remark: 'mini marketing activity notify',
      pageQuery: params.pageQuery,
      values: {
        activityName: params.activityName,
        startAt: this.formatDateTime(params.startAt || new Date()),
        benefit: params.benefit || '',
        remark: params.remark || '',
      },
    });
  }
}
