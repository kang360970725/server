import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createVerify,
  randomBytes,
} from 'crypto';
import {
  OrderPayStatus,
  OrderStatus,
  Prisma,
  UserCouponStatus,
  WalletBizType,
  WalletDirection,
  WalletTxStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import {
  SHOUQIANBA_API_BASE,
  SHOUQIANBA_CALLBACK_PUBLIC_KEY,
} from './shouqianba.constants';

@Injectable()
export class ShouqianbaService {
  private readonly logger = new Logger(ShouqianbaService.name);
  private reconciling = false;
  private dailyCheckinPromise: Promise<any> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  private config() {
    return {
      vendorSn: String(process.env.SHOUQIANBA_VENDOR_SN || '').trim(),
      vendorKey: String(process.env.SHOUQIANBA_VENDOR_KEY || '').trim(),
      appId: String(process.env.SHOUQIANBA_APP_ID || '').trim(),
      deviceId: String(
        process.env.SHOUQIANBA_DEVICE_ID || 'BLUECAT_SERVER_CSB_TEST_01',
      ).trim(),
      notifyUrl: String(process.env.SHOUQIANBA_NOTIFY_URL || '').trim(),
      apiBase: String(
        process.env.SHOUQIANBA_API_BASE || SHOUQIANBA_API_BASE,
      ).replace(/\/$/, ''),
    };
  }

  getConfigurationStatus() {
    const c = this.config();
    return {
      configured: Boolean(c.vendorSn && c.vendorKey && c.appId),
      vendorSnConfigured: Boolean(c.vendorSn),
      vendorKeyConfigured: Boolean(c.vendorKey),
      appIdConfigured: Boolean(c.appId),
      notifyUrlConfigured: Boolean(c.notifyUrl),
      credentialEncryptionKeyConfigured: Boolean(
        String(process.env.SHOUQIANBA_CREDENTIAL_ENCRYPTION_KEY || '').trim(),
      ),
      deviceId: c.deviceId,
      apiBase: c.apiBase,
    };
  }

  private encryptionKey() {
    const c = this.config();
    if (!c.vendorKey || !c.appId)
      throw new ServiceUnavailableException('收钱吧开发者参数未配置');
    const configuredKey = String(
      process.env.SHOUQIANBA_CREDENTIAL_ENCRYPTION_KEY || '',
    ).trim();
    if (process.env.NODE_ENV === 'production' && !configuredKey) {
      throw new ServiceUnavailableException(
        '生产环境必须配置独立的收钱吧凭据加密密钥',
      );
    }
    const source = configuredKey || `${c.vendorKey}:${c.appId}`;
    return createHash('sha256').update(source, 'utf8').digest();
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);
    return {
      cipher: encrypted.toString('base64'),
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
    };
  }

  private decrypt(row: any) {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey(),
      Buffer.from(row.terminalKeyIv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(row.terminalKeyTag, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(row.terminalKeyCipher, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  private sign(body: string, key: string) {
    return createHash('md5')
      .update(body + key, 'utf8')
      .digest('hex');
  }

  private sanitizeAuditPayload(value: any): any {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value))
      return value.slice(0, 100).map((item) => this.sanitizeAuditPayload(item));
    if (typeof value !== 'object') {
      if (typeof value === 'string' && value.length > 2000)
        return `${value.slice(0, 2000)}...[truncated]`;
      return value;
    }
    const sensitiveKeys = new Set([
      'authorization',
      'signature',
      'sign',
      'vendorkey',
      'terminalkey',
      'credentialencryptionkey',
      'code',
      'qrcode',
      'qrcodeimageurl',
      'dynamicid',
      'payerlogin',
      'payeruid',
    ]);
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        sensitiveKeys.has(name.toLowerCase().replace(/[_-]/g, ''))
          ? '[REDACTED]'
          : this.sanitizeAuditPayload(item),
      ]),
    );
  }

  private async recordApiLog(input: {
    endpoint: string;
    direction?: 'OUTBOUND' | 'INBOUND';
    requestPayload?: any;
    responsePayload?: any;
    httpStatus?: number;
    durationMs?: number;
    success: boolean;
    errorMessage?: string;
  }) {
    try {
      const requestPayload = this.sanitizeAuditPayload(input.requestPayload);
      const responsePayload = this.sanitizeAuditPayload(input.responsePayload);
      const response: any = input.responsePayload || {};
      const result: any = response?.biz_response?.data || response;
      const delegate = (this.prisma as any).shouqianbaApiLog;
      if (!delegate?.create) return;
      await delegate.create({
        data: {
          endpoint: input.endpoint,
          direction: input.direction || 'OUTBOUND',
          clientSn: String(
            input.requestPayload?.client_sn || result?.client_sn || '',
          ).slice(0, 32) || null,
          providerSn: String(result?.sn || '').slice(0, 32) || null,
          requestPayload: requestPayload as Prisma.InputJsonValue,
          responsePayload: responsePayload as Prisma.InputJsonValue,
          httpStatus: input.httpStatus,
          resultCode: String(response?.result_code || '').slice(0, 40) || null,
          bizResultCode:
            String(response?.biz_response?.result_code || '').slice(0, 40) ||
            null,
          success: input.success,
          durationMs: input.durationMs,
          errorMessage:
            String(input.errorMessage || '').slice(0, 500) || null,
        },
      });
    } catch (error: any) {
      this.logger.warn(
        `shouqianba audit log failed endpoint=${input.endpoint}: ${error?.message || error}`,
      );
    }
  }

  private requireBusinessEnvelope(
    data: any,
    operation: string,
    acceptedBizCodes: string[],
  ) {
    if (String(data?.result_code) !== '200') {
      throw new BadGatewayException(
        data?.error_message || `${operation}通讯失败`,
      );
    }
    const biz = data?.biz_response;
    if (!biz || !acceptedBizCodes.includes(String(biz?.result_code || ''))) {
      throw new BadGatewayException(
        biz?.error_message || `${operation}业务处理失败`,
      );
    }
    return biz;
  }

  private async post(
    path: string,
    payload: Record<string, any>,
    sn: string,
    key: string,
  ) {
    const startedAt = Date.now();
    const body = JSON.stringify(payload);
    try {
      const response = await fetch(`${this.config().apiBase}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `${sn} ${this.sign(body, key)}`,
        },
        body,
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        await this.recordApiLog({
          endpoint: path,
          requestPayload: payload,
          responsePayload: { invalidJson: true },
          httpStatus: response.status,
          durationMs: Date.now() - startedAt,
          success: false,
          errorMessage: '收钱吧响应不是有效JSON',
        });
        throw new BadGatewayException('收钱吧响应不是有效JSON');
      }
      const communicationSuccess =
        response.ok && String(data?.result_code) === '200';
      const bizResultCode = String(data?.biz_response?.result_code || '');
      const businessSuccess =
        communicationSuccess &&
        !data?.biz_response?.error_code &&
        !['FAIL', 'ERROR'].includes(bizResultCode.toUpperCase());
      await this.recordApiLog({
        endpoint: path,
        requestPayload: payload,
        responsePayload: data,
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        success: businessSuccess,
        errorMessage: businessSuccess
          ? undefined
          : data?.error_message || data?.biz_response?.error_message,
      });
      if (!response.ok)
        throw new BadGatewayException(
          `收钱吧HTTP请求失败：${response.status}`,
        );
      return data;
    } catch (error: any) {
      if (error instanceof BadGatewayException) throw error;
      await this.recordApiLog({
        endpoint: path,
        requestPayload: payload,
        durationMs: Date.now() - startedAt,
        success: false,
        errorMessage: error?.message || 'network error',
      });
      throw new BadGatewayException(
        `收钱吧接口连接失败：${error?.message || 'network error'}`,
      );
    }
  }

  async terminalStatus() {
    const terminal = await this.prisma.shouqianbaTerminal.findFirst({
      where: { deviceId: this.config().deviceId },
      orderBy: { id: 'desc' },
      select: {
        id: true,
        appId: true,
        deviceId: true,
        terminalSn: true,
        name: true,
        status: true,
        activatedAt: true,
        lastCheckedInAt: true,
      },
    });
    return { ...this.getConfigurationStatus(), terminal };
  }

  private shanghaiDayKey(value: Date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(value);
    const pick = (type: string) =>
      parts.find((part) => part.type === type)?.value || '';
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  }

  private async ensureDailyCheckin(terminal: any) {
    if (
      terminal?.lastCheckedInAt &&
      this.shanghaiDayKey(new Date(terminal.lastCheckedInAt)) ===
        this.shanghaiDayKey(new Date())
    ) {
      return terminal;
    }
    if (!this.dailyCheckinPromise) {
      this.dailyCheckinPromise = this.checkin().finally(() => {
        this.dailyCheckinPromise = null;
      });
    }
    await this.dailyCheckinPromise;
    const refreshed = await this.prisma.shouqianbaTerminal.findUnique({
      where: { deviceId: this.config().deviceId },
    });
    if (!refreshed)
      throw new ServiceUnavailableException('收钱吧终端签到后不存在');
    return refreshed;
  }

  /** 激活会消耗激活码次数，只允许显式调用，且同一device_id已有终端时拒绝再次激活。 */
  async activate(codeInput: string, confirm: boolean) {
    if (!confirm) throw new BadRequestException('激活会消耗次数，必须显式确认');
    const c = this.config();
    if (!c.vendorSn || !c.vendorKey || !c.appId)
      throw new ServiceUnavailableException('收钱吧开发者参数未配置');
    const existing = await this.prisma.shouqianbaTerminal.findUnique({
      where: { deviceId: c.deviceId },
    });
    if (existing)
      throw new ConflictException(
        '当前device_id已经激活，禁止重复消耗激活次数',
      );
    const code = String(codeInput || '').trim();
    if (!/^\d{8}$/.test(code))
      throw new BadRequestException('激活码格式错误');
    const data = await this.post(
      '/terminal/activate',
      {
        app_id: c.appId,
        code,
        device_id: c.deviceId,
        name: 'BlueCat C扫B服务端',
        os_info: process.platform,
        sdk_version: 'bluecat-1.0',
      },
      c.vendorSn,
      c.vendorKey,
    );
    if (
      String(data?.result_code) !== '200' ||
      !data?.biz_response?.terminal_sn ||
      !data?.biz_response?.terminal_key
    ) {
      throw new BadGatewayException(
        data?.error_message ||
          data?.biz_response?.error_message ||
          '收钱吧终端激活失败',
      );
    }
    const encrypted = this.encrypt(String(data.biz_response.terminal_key));
    const terminal = await this.prisma.shouqianbaTerminal.create({
      data: {
        appId: c.appId,
        deviceId: c.deviceId,
        terminalSn: String(data.biz_response.terminal_sn),
        terminalKeyCipher: encrypted.cipher,
        terminalKeyIv: encrypted.iv,
        terminalKeyTag: encrypted.tag,
        name: 'BlueCat C扫B服务端',
        status: 'ACTIVE',
      },
    });
    return {
      id: terminal.id,
      deviceId: terminal.deviceId,
      terminalSn: terminal.terminalSn,
      status: terminal.status,
      activatedAt: terminal.activatedAt,
    };
  }

  async checkin() {
    const c = this.config();
    const terminal = await this.prisma.shouqianbaTerminal.findUnique({
      where: { deviceId: c.deviceId },
    });
    if (!terminal) throw new ServiceUnavailableException('收钱吧终端尚未激活');
    const data = await this.post(
      '/terminal/checkin',
      { device_id: c.deviceId, terminal_sn: terminal.terminalSn },
      terminal.terminalSn,
      this.decrypt(terminal),
    );
    if (
      String(data?.result_code) !== '200' ||
      !data?.biz_response?.terminal_key
    ) {
      throw new BadGatewayException(
        data?.error_message ||
          data?.biz_response?.error_message ||
          '收钱吧签到失败',
      );
    }
    const encrypted = this.encrypt(String(data.biz_response.terminal_key));
    const updated = await this.prisma.shouqianbaTerminal.update({
      where: { id: terminal.id },
      data: {
        terminalSn: String(
          data.biz_response.terminal_sn || terminal.terminalSn,
        ),
        terminalKeyCipher: encrypted.cipher,
        terminalKeyIv: encrypted.iv,
        terminalKeyTag: encrypted.tag,
        lastCheckedInAt: new Date(),
        status: 'ACTIVE',
      },
    });
    return {
      id: updated.id,
      deviceId: updated.deviceId,
      terminalSn: updated.terminalSn,
      status: updated.status,
      lastCheckedInAt: updated.lastCheckedInAt,
    };
  }

  async precreatePayment(paymentId: number, operator = 'BlueCat') {
    const c = this.config();
    const [payment, terminal] = await Promise.all([
      this.prisma.orderPayment.findUnique({
        where: { id: paymentId },
        include: { order: { include: { project: true } } },
      }),
      this.prisma.shouqianbaTerminal.findUnique({
        where: { deviceId: c.deviceId },
      }),
    ]);
    if (!payment) throw new BadRequestException('支付尝试不存在');
    if (!terminal)
      return {
        paymentId,
        integrationStatus: 'WAITING_FOR_TERMINAL_ACTIVATION',
        clientSn: payment.clientSn,
      };
    const readyTerminal = await this.ensureDailyCheckin(terminal);
    const amountFen = Math.round(Number(payment.amount) * 100);
    const payload: any = {
      client_sn: payment.clientSn,
      operator: String(operator || 'BlueCat').slice(0, 45),
      subject: String(
        payment.order?.project?.name || payment.order?.autoSerial || '订单支付',
      ).slice(0, 64),
      terminal_sn: readyTerminal.terminalSn,
      total_amount: String(amountFen),
    };
    if (c.notifyUrl) payload.notify_url = c.notifyUrl;
    const data = await this.post(
      '/upay/support/precreateQrcode',
      payload,
      readyTerminal.terminalSn,
      this.decrypt(readyTerminal),
    );
    let biz: any;
    try {
      biz = this.requireBusinessEnvelope(data, '预下单', [
        'PRECREATE_SUCCESS',
      ]);
    } catch (error) {
      await this.prisma.orderPayment.update({
        where: { id: payment.id },
        data: { status: OrderPayStatus.UNKNOWN, notifyRaw: data },
      });
      throw error;
    }
    const qrCode = String(biz.data?.qr_code || '');
    const qrCodeImageUrl = String(
      biz.data?.qr_code_image_url || '',
    );
    await this.prisma.orderPayment.update({
      where: { id: payment.id },
      data: { qrCode, qrCodeImageUrl, notifyRaw: data },
    });
    return {
      paymentId: payment.id,
      orderId: payment.orderId,
      clientSn: payment.clientSn,
      purpose: payment.purpose,
      attemptNo: payment.attemptNo,
      amount: Number(payment.amount),
      expiresAt: payment.expiresAt,
      paymentUrl: qrCode,
      qrCodeContent: qrCode,
      qrCodeImageUrl,
      integrationStatus: 'READY',
    };
  }

  /** 撤销仍有效的旧付款码，避免修改订单后新旧金额同时可支付。 */
  async cancelPayment(paymentId: number, operator = 'BlueCat') {
    const c = this.config();
    const [payment, terminal] = await Promise.all([
      this.prisma.orderPayment.findUnique({ where: { id: paymentId } }),
      this.prisma.shouqianbaTerminal.findUnique({
        where: { deviceId: c.deviceId },
      }),
    ]);
    if (!payment) throw new BadRequestException('支付尝试不存在');
    if (!terminal) throw new ServiceUnavailableException('收钱吧终端尚未激活');
    const readyTerminal = await this.ensureDailyCheckin(terminal);
    const payload: any = {
      terminal_sn: readyTerminal.terminalSn,
      operator: String(operator || 'BlueCat').slice(0, 64),
    };
    if (payment.providerSn) payload.sn = payment.providerSn;
    else payload.client_sn = payment.clientSn;
    const data = await this.post(
      '/upay/v2/cancel',
      payload,
      readyTerminal.terminalSn,
      this.decrypt(readyTerminal),
    );
    const biz = this.requireBusinessEnvelope(data, '撤销', [
      'CANCEL_SUCCESS',
    ]);
    const result = biz?.data;
    const succeeded =
      String(result?.status) === 'SUCCESS';
    if (!succeeded) {
      throw new BadGatewayException(
        biz?.error_message ||
          data?.error_message ||
          '旧付款码撤销失败，请稍后重试',
      );
    }
    await this.prisma.orderPayment.update({
      where: { id: payment.id },
      data: {
        status: OrderPayStatus.CLOSED,
        providerOrderStatus: String(result?.order_status || 'CANCELED'),
        notifyRaw: data,
      },
    });
    return data;
  }

  /** 收钱吧原路退款；只有明确的终态成功才允许业务订单进入已退款。 */
  async refundPayment(input: {
    paymentId: number;
    refundRequestNo: string;
    amountFen: number;
    operator?: string;
  }) {
    const c = this.config();
    const [payment, terminal] = await Promise.all([
      this.prisma.orderPayment.findUnique({
        where: { id: Number(input.paymentId) },
      }),
      this.prisma.shouqianbaTerminal.findUnique({
        where: { deviceId: c.deviceId },
      }),
    ]);
    if (!payment) throw new BadRequestException('原支付流水不存在');
    if (!terminal) throw new ServiceUnavailableException('收钱吧终端尚未激活');
    const readyTerminal = await this.ensureDailyCheckin(terminal);
    const payload: any = {
      terminal_sn: readyTerminal.terminalSn,
      refund_request_no: String(input.refundRequestNo || '').slice(0, 20),
      operator: String(input.operator || 'BlueCat').slice(0, 64),
      refund_amount: String(Math.round(Number(input.amountFen))),
    };
    if (payment.providerSn) payload.sn = payment.providerSn;
    else payload.client_sn = payment.clientSn;
    const data = await this.post(
      '/upay/v2/refund',
      payload,
      readyTerminal.terminalSn,
      this.decrypt(readyTerminal),
    );
    const biz = this.requireBusinessEnvelope(data, '退款', [
      'REFUND_SUCCESS',
    ]);
    const result = biz?.data;
    const finalSuccess =
      String(result?.status) === 'SUCCESS' &&
      ['REFUNDED', 'PARTIAL_REFUNDED'].includes(String(result?.order_status));
    if (!finalSuccess) {
      throw new BadGatewayException(
        biz?.error_message ||
          data?.error_message ||
          `退款尚未成功（${result?.order_status || result?.status || 'UNKNOWN'}）`,
      );
    }
    return {
      refundId: String(
        result?.client_tsn || result?.sn || input.refundRequestNo,
      ),
      status: String(result.status),
      orderStatus: String(result.order_status),
      raw: data,
    };
  }

  /**
   * 主动查询收钱吧订单。预下单不能只依赖异步通知，否则回调丢失会造成单边账。
   */
  async queryPayment(paymentId: number) {
    const c = this.config();
    const [payment, terminal] = await Promise.all([
      this.prisma.orderPayment.findUnique({ where: { id: Number(paymentId) } }),
      this.prisma.shouqianbaTerminal.findUnique({
        where: { deviceId: c.deviceId },
      }),
    ]);
    if (!payment) throw new BadRequestException('支付尝试不存在');
    if (!terminal) throw new ServiceUnavailableException('收钱吧终端尚未激活');
    const readyTerminal = await this.ensureDailyCheckin(terminal);
    const payload: any = { terminal_sn: readyTerminal.terminalSn };
    if (payment.providerSn) payload.sn = payment.providerSn;
    else payload.client_sn = payment.clientSn;

    const data = await this.post(
      '/upay/v2/query',
      payload,
      readyTerminal.terminalSn,
      this.decrypt(readyTerminal),
    );
    await this.prisma.orderPayment.update({
      where: { id: payment.id },
      data: {
        lastQueriedAt: new Date(),
        queryAttempts: { increment: 1 },
        notifyRaw: data,
      },
    });
    const providerErrorCode = String(data?.biz_response?.error_code || '');
    const expiredWithoutProviderOrder = Boolean(
      providerErrorCode === 'UPAY_ORDER_NOT_EXISTS' &&
        payment.expiresAt &&
        payment.expiresAt.getTime() + 2 * 60_000 < Date.now(),
    );
    if (expiredWithoutProviderOrder) {
      await this.applyProviderResult(
        {
          client_sn: payment.clientSn,
          sn: payment.providerSn,
          status: 'FAIL',
          order_status: 'EXPIRED',
          provider_error: data?.biz_response,
        },
        'QUERY',
      );
      return {
        paymentId: payment.id,
        status: 'FAIL',
        orderStatus: 'EXPIRED',
        clientSn: String(payment.clientSn || ''),
      };
    }
    const biz = this.requireBusinessEnvelope(data, '查单', ['SUCCESS']);
    const result = biz?.data;
    if (!result?.client_sn)
      throw new BadGatewayException('收钱吧查单结果缺少client_sn');
    await this.applyProviderResult(result, 'QUERY');
    return {
      paymentId: payment.id,
      status: String(result.status || ''),
      orderStatus: String(result.order_status || ''),
      clientSn: String(result.client_sn || ''),
    };
  }

  /** 按官方建议在二维码有效期内查单，并在第6分钟做最后一次核对。 */
  @Cron('*/5 * * * * *')
  async reconcilePendingPayments() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const now = Date.now();
      const candidates = await this.prisma.orderPayment.findMany({
        where: {
          channel: 'SHOUQIANBA_WAP',
          status: {
            in: [
              OrderPayStatus.PENDING,
              OrderPayStatus.PROCESSING,
              OrderPayStatus.UNKNOWN,
            ],
          },
          createdAt: { gte: new Date(now - 6 * 60_000) },
        },
        select: { id: true, createdAt: true, lastQueriedAt: true },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      const due = candidates
        .filter((payment) => {
          const age = now - payment.createdAt.getTime();
          const sinceLast = payment.lastQueriedAt
            ? now - payment.lastQueriedAt.getTime()
            : Number.POSITIVE_INFINITY;
          if (age < 0 || age > 6 * 60_000) return false;
          const interval = age < 2 * 60_000 ? 5_000 : 10_000;
          return sinceLast >= interval;
        })
        .slice(0, 20);
      await Promise.all(
        due.map(async (payment) => {
          try {
            await this.queryPayment(payment.id);
          } catch (error: any) {
            this.logger.warn(
              `payment query failed id=${payment.id}: ${error?.message || error}`,
            );
          }
        }),
      );
    } finally {
      this.reconciling = false;
    }
  }

  private normalizeIdList(value: any) {
    const list = Array.isArray(value) ? value : [];
    return [
      ...new Set(
        list
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item > 0),
      ),
    ];
  }

  /** 付款前的服务者仅是预选；支付成功后全部仍为空闲才真正创建首轮派单。 */
  private async autoDispatchPreselectedPlayers(orderId: number) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM `Order` WHERE id = ? FOR UPDATE',
        orderId,
      );
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (
        !order ||
        !order.isPaid ||
        String(order.status) !== 'WAIT_ASSIGN' ||
        order.currentDispatchId
      )
        return;
      const playerIds = this.normalizeIdList(
        (order as any).preselectedPlayerIds,
      );
      if (!playerIds.length) return;
      const attributionIds = this.normalizeIdList(
        (order as any).preselectedAttributionIds,
      );
      const attributionType = String(
        (order as any).preselectedAttributionType || '',
      ).toUpperCase();

      const placeholders = playerIds.map(() => '?').join(',');
      await tx.$queryRawUnsafe(
        `SELECT id FROM users WHERE id IN (${placeholders}) FOR UPDATE`,
        ...playerIds,
      );
      const players = await tx.user.findMany({
        where: { id: { in: playerIds } },
        select: {
          id: true,
          workStatus: true,
          status: true,
          staffEmploymentStatus: true,
        },
      });
      const allIdle =
        players.length === playerIds.length &&
        players.every(
          (player: any) =>
            String(player.workStatus) === 'IDLE' &&
            String(player.status) === 'ACTIVE' &&
            String(player.staffEmploymentStatus) === 'ACTIVE',
        );
      if (!allIdle) {
        if (order.dispatcherId) {
          await tx.userLog.create({
            data: {
              userId: order.dispatcherId,
              action: 'AUTO_DISPATCH_SKIPPED',
              targetType: 'ORDER',
              targetId: order.id,
              oldData: { preselectedPlayerIds: playerIds } as any,
              newData: { status: 'WAIT_ASSIGN' } as any,
              remark:
                '在线付款成功，但预选服务者存在非空闲状态，已阻断自动派单',
            },
          });
        }
        return;
      }

      const dispatch = await tx.orderDispatch.create({
        data: {
          orderId: order.id,
          round: 1,
          status: 'WAIT_ACCEPT' as any,
          assignedAt: new Date(),
          remark: 'ONLINE_PAYMENT_AUTO_DISPATCH',
        },
      });
      await tx.orderParticipant.createMany({
        data: playerIds.map((userId) => ({
          dispatchId: dispatch.id,
          userId,
          isActive: true,
        })),
      });

      if (attributionIds.length) {
        const invalidAttributionIds = attributionIds.filter(
          (id) => !playerIds.includes(id),
        );
        if (invalidAttributionIds.length) {
          throw new BadRequestException('分红归因服务者必须从预选服务者中选择');
        }
        const attributionUsers = await tx.user.findMany({
          where: { id: { in: attributionIds } },
          select: { id: true, name: true, phone: true },
        });
        if (attributionUsers.length !== attributionIds.length) {
          throw new BadRequestException('分红归因服务者不存在或已不可用');
        }
        const userMap = new Map<number, any>(
          attributionUsers.map((user: any) => [Number(user.id), user]),
        );
        const isDesignated = attributionType === 'DESIGNATED';
        let eligibleUserIds = attributionIds;
        let eligibilitySnapshot: any[] = attributionIds.map((id) => ({
          userId: id,
          name: userMap.get(id)?.name || `#${id}`,
          eligible: true,
          source: 'DESIGNATED_ALL_STAFF',
        }));
        if (!isDesignated) {
          const excellentRows = await tx.excellentStaff.findMany({
            where: { userId: { in: attributionIds }, status: 'ACTIVE' },
            select: { userId: true, assignedAt: true },
          });
          const excellentMap = new Map<number, any>(
            excellentRows.map((row: any) => [Number(row.userId), row]),
          );
          eligibleUserIds = attributionIds.filter((id) => excellentMap.has(id));
          eligibilitySnapshot = attributionIds.map((id) => ({
            id,
            name: userMap.get(id)?.name || `#${id}`,
            phone: userMap.get(id)?.phone || null,
            eligible: excellentMap.has(id),
            excellentAssignedAt: excellentMap.get(id)?.assignedAt || null,
          }));
        }
        await tx.orderRenewalGroup.create({
          data: {
            orderId: order.id,
            dispatchId: dispatch.id,
            groupKey: [...attributionIds].sort((a, b) => a - b).join(','),
            attributionType: isDesignated ? 'DESIGNATED' : 'RENEWAL',
            memberUserIds: attributionIds as any,
            memberNamesSnapshot: attributionIds.map((id) => ({
              id,
              name: userMap.get(id)?.name || `#${id}`,
              phone: userMap.get(id)?.phone || null,
            })) as any,
            bonusEligibleUserIds: eligibleUserIds as any,
            bonusEligibleSnapshot: eligibilitySnapshot as any,
            status: 'PENDING',
            createdBy: order.dispatcherId || null,
          },
        });
      }
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'WAIT_ACCEPT' as any,
          currentDispatchId: dispatch.id,
          ...(attributionIds.length
            ? { isRenewal: true, inviter: null, inviteRate: 0 }
            : {}),
          preselectedPlayerIds: Prisma.DbNull,
          preselectedAttributionIds: Prisma.DbNull,
          preselectedAttributionType: null,
        },
      });
      if (order.dispatcherId) {
        await tx.userLog.create({
          data: {
            userId: order.dispatcherId,
            action: 'AUTO_DISPATCH_AFTER_PAYMENT',
            targetType: 'ORDER',
            targetId: order.id,
            oldData: {
              status: 'WAIT_ASSIGN',
              preselectedPlayerIds: playerIds,
            } as any,
            newData: {
              status: 'WAIT_ACCEPT',
              dispatchId: dispatch.id,
              playerIds,
            } as any,
            remark: '收钱吧付款成功，预选服务者均为空闲，自动派单',
          },
        });
      }
    });
  }

  verifyCallback(rawBody: Buffer, authorization: string) {
    const signature = String(authorization || '').trim();
    if (!signature || !rawBody?.length) return false;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(rawBody);
    verifier.end();
    try {
      return verifier.verify(
        SHOUQIANBA_CALLBACK_PUBLIC_KEY,
        signature,
        'base64',
      );
    } catch {
      return false;
    }
  }

  async handleCallback(rawBody: Buffer, authorization: string, payload: any) {
    if (!this.verifyCallback(rawBody, authorization)) {
      await this.recordApiLog({
        endpoint: '/shouqianba/notify',
        direction: 'INBOUND',
        requestPayload: payload,
        success: false,
        errorMessage: '收钱吧回调验签失败',
      });
      throw new BadRequestException('收钱吧回调验签失败');
    }
    const clientSn = String(payload?.client_sn || '').trim();
    const payment = clientSn
      ? await this.prisma.orderPayment.findUnique({ where: { clientSn } })
      : null;
    await this.applyProviderResult(payload, 'CALLBACK');
    await this.recordApiLog({
      endpoint: '/shouqianba/notify',
      direction: 'INBOUND',
      requestPayload: payload,
      responsePayload: { acknowledgement: 'success' },
      success: true,
    });
    const finalStatus = String(payload?.order_status || '').toUpperCase();
    if (
      payment?.id &&
      [
        'PAID',
        'REFUNDED',
        'PARTIAL_REFUNDED',
        'CANCELED',
        'CANCELLED',
        'EXPIRED',
      ].includes(finalStatus)
    ) {
      try {
        await this.queryPayment(Number(payment.id));
      } catch (error: any) {
        this.logger.warn(
          `callback final-state confirmation query failed payment=${payment.id}: ${error?.message || error}`,
        );
      }
    }
    return 'success';
  }

  private async applyProviderResult(
    payload: any,
    verificationSource: 'CALLBACK' | 'QUERY',
  ) {
    const clientSn = String(payload?.client_sn || '').trim();
    if (!clientSn) throw new BadRequestException('收钱吧结果缺少client_sn');
    const success =
      String(payload?.order_status) === 'PAID' &&
      String(payload?.status) === 'SUCCESS';
    const providerOrderStatus = String(
      payload?.order_status || '',
    ).toUpperCase();
    const finalFailure = [
      'CANCELED',
      'CANCELLED',
      'EXPIRED',
      'PAY_CANCELED',
      'PAY_CANCELLED',
    ].includes(providerOrderStatus);
    const localStatus = success
      ? OrderPayStatus.SUCCESS
      : finalFailure
        ? OrderPayStatus.FAILED
        : providerOrderStatus === 'CREATED'
          ? OrderPayStatus.PROCESSING
          : OrderPayStatus.UNKNOWN;
    const paidOrderId = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.orderPayment.findUnique({ where: { clientSn } });
      if (!payment) throw new BadRequestException('收钱吧回调对应支付单不存在');
      await tx.$queryRawUnsafe(
        'SELECT id FROM `Order` WHERE id = ? FOR UPDATE',
        payment.orderId,
      );
      const order = await tx.order.findUnique({
        where: { id: payment.orderId },
      });
      if (!order) throw new BadRequestException('订单不存在');
      // 成功状态不可被乱序/重复的失败通知回退。
      if (payment.status === OrderPayStatus.SUCCESS && !success) return null;
      const paidAt = payload?.finish_time
        ? new Date(Number(payload.finish_time))
        : new Date();
      await tx.orderPayment.update({
        where: { id: payment.id },
        data: {
          status: localStatus,
          providerSn: String(payload?.sn || '') || payment.providerSn || null,
          transactionId: String(payload?.trade_no || '') || null,
          providerOrderStatus: String(payload?.order_status || '') || null,
          payway: String(payload?.payway || '') || null,
          subPayway: String(payload?.sub_payway || '') || null,
          netAmount: Number(payload?.net_amount || 0) / 100,
          settlementAmount: Number(payload?.settlement_amount || 0) / 100,
          paidAt: success ? paidAt : null,
          verifiedAt: new Date(),
          verificationSource,
          notifyRaw: payload,
        },
      });
      if (!success) {
        const paymentOnlyOrder =
          new Set<OrderStatus>([
            OrderStatus.DRAFT,
            OrderStatus.WAIT_PAYMENT,
          ]).has(order.status) ||
          (order.status === OrderStatus.WAIT_ASSIGN &&
            !order.currentDispatchId);
        if (
          finalFailure &&
          Number(order.latestPaymentId || 0) === Number(payment.id) &&
          !order.isPaid &&
          paymentOnlyOrder
        ) {
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: OrderStatus.DRAFT,
              payStatus: OrderPayStatus.FAILED,
            },
          });
        }
        return null;
      }
      const settledByCsLiability = Boolean(
        order.unpaidAutoDeductedAt &&
          order.unpaidResponsibleUserId &&
          Number(order.unpaidAutoDeductedAmount) > 0,
      );
      if (settledByCsLiability) {
        const amount = Number(order.unpaidAutoDeductedAmount);
        const reversal = await tx.walletTransaction.findUnique({
          where: {
            sourceType_sourceId: {
              sourceType: 'ORDER_UNPAID_CS_LIABILITY_REVERSAL',
              sourceId: order.id,
            },
          },
          select: { id: true },
        });
        if (!reversal) {
          const after = await this.wallet.applyWalletAccountDelta(
            tx as any,
            Number(order.unpaidResponsibleUserId),
            { availableDelta: amount },
          );
          await tx.walletTransaction.create({
            data: {
              userId: Number(order.unpaidResponsibleUserId),
              direction: WalletDirection.IN,
              bizType: WalletBizType.ORDER_UNPAID_CS_LIABILITY_REVERSAL,
              amount,
              status: WalletTxStatus.AVAILABLE,
              sourceType: 'ORDER_UNPAID_CS_LIABILITY_REVERSAL',
              sourceId: order.id,
              orderId: order.id,
              availableAfter: Number(after?.availableBalance || 0),
              frozenAfter: Number(after?.frozenBalance || 0),
              remark: `订单 ${order.autoSerial} 顾客后续支付成功，退回客服责任代扣`,
            },
          });
        }
        await tx.orderReceipt.updateMany({
          where: { receiptKey: `CS_LIABILITY:${order.id}` },
          data: { channel: 'SHOUQIANBA_WAP', paidAt },
        });
      } else {
        // 每条真实成功流水生成独立快照，补收可累计，重复回调不会重复入账。
        await tx.orderReceipt.upsert({
          where: { receiptKey: `SHOUQIANBA:${payment.id}` },
          update: {},
          create: {
            receiptKey: `SHOUQIANBA:${payment.id}`,
            orderId: order.id,
            autoSerial: order.autoSerial,
            kind: payment.purpose === 'SUPPLEMENT' ? 'SUPPLEMENT' : 'PAYMENT',
            amount: payment.amount,
            paidAt,
            orderSource: String(order.orderSource || 'UNKNOWN'),
            channel: 'SHOUQIANBA_WAP',
            dispatcherId: order.dispatcherId,
          },
        });
      }
      // 一次收款成功后，关闭同用途的其他本地待支付尝试，避免后台继续展示旧二维码。
      await tx.orderPayment.updateMany({
        where: {
          orderId: order.id,
          purpose: payment.purpose,
          id: { not: payment.id },
          status: {
            in: [
              OrderPayStatus.PENDING,
              OrderPayStatus.PROCESSING,
              OrderPayStatus.UNKNOWN,
            ],
          },
        },
        data: { status: OrderPayStatus.CLOSED },
      });
      const paid = await tx.orderPayment.aggregate({
        where: { orderId: order.id, status: OrderPayStatus.SUCCESS },
        _sum: { amount: true },
      });
      // 在线支付成功才正式核销创建订单时预留的优惠券；重复回调不会重复计数。
      const reservedCoupons = await tx.userCoupon.findMany({
        where: { orderId: order.id, status: UserCouponStatus.UNUSED },
        select: { id: true, templateId: true },
      });
      for (const coupon of reservedCoupons) {
        const consumed = await tx.userCoupon.updateMany({
          where: {
            id: coupon.id,
            orderId: order.id,
            status: UserCouponStatus.UNUSED,
          },
          data: { status: UserCouponStatus.USED, usedAt: paidAt },
        });
        if (consumed.count === 1) {
          await tx.couponTemplate.update({
            where: { id: coupon.templateId },
            data: { usedCount: { increment: 1 } },
          });
        }
      }
      await tx.order.update({
        where: { id: order.id },
        data: {
          isPaid: true,
          payStatus: OrderPayStatus.SUCCESS,
          paymentTime: paidAt,
          latestPaymentId: payment.id,
          paidAmount: Number(paid._sum.amount || 0),
          status: new Set<OrderStatus>([
            OrderStatus.DRAFT,
            OrderStatus.WAIT_PAYMENT,
          ]).has(order.status)
            ? OrderStatus.WAIT_ASSIGN
            : undefined,
        },
      });
      return order.id;
    });
    if (paidOrderId) {
      try {
        await this.autoDispatchPreselectedPlayers(Number(paidOrderId));
      } catch (error: any) {
        this.logger.error(
          `payment succeeded but auto dispatch failed order=${paidOrderId}: ${error?.message || error}`,
          error?.stack,
        );
      }
    }
    return { paidOrderId, status: localStatus };
  }
}
