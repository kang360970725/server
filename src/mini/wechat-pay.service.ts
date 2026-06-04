import { BadRequestException, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createSign } from 'crypto';
import { SystemConfigService } from '../system-config/system-config.service';
import { getWechatOrderNotifyUrlFromConfig } from './wechat-callback.util';

@Injectable()
export class WechatPayService {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  private async getRuntimeConfig() {
    const mchId = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_PAY_MCHID,
      String(process.env.WECHAT_PAY_MCHID || '').trim(),
    );
    const appId = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_MINI_APPID,
      String(process.env.WECHAT_PAY_APPID || '').trim(),
    );
    const serialNo = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_PAY_SERIAL_NO,
      String(process.env.WECHAT_PAY_SERIAL_NO || '').trim(),
    );
    const privateKey = (
      await this.systemConfigService.getString(
        SystemConfigService.KEYS.WECHAT_PAY_PRIVATE_KEY,
        String(process.env.WECHAT_PAY_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      )
    ).replace(/\\n/g, '\n');
    const apiV3Key = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_PAY_API_V3_KEY,
      String(process.env.WECHAT_PAY_API_V3_KEY || '').trim(),
    );
    const notifyUrl = await getWechatOrderNotifyUrlFromConfig(this.systemConfigService);
    return { mchId, appId, serialNo, privateKey, apiV3Key, notifyUrl };
  }

  async isReady() {
    const cfg = await this.getRuntimeConfig();
    return !!(cfg.mchId && cfg.appId && cfg.serialNo && cfg.privateKey && cfg.apiV3Key && cfg.notifyUrl);
  }

  async getConfigStatus() {
    const cfg = await this.getRuntimeConfig();
    const envMock = String(process.env.WECHAT_PAY_MOCK || '').trim() === '1';
    return {
      mchId: !!cfg.mchId,
      appId: !!cfg.appId,
      serialNo: !!cfg.serialNo,
      privateKey: !!cfg.privateKey,
      privateKeyFormatOk: cfg.privateKey.includes('BEGIN PRIVATE KEY'),
      apiV3Key: !!cfg.apiV3Key,
      notifyUrl: !!cfg.notifyUrl,
      mock: envMock,
      ready: await this.isReady(),
    };
  }

  private buildAuthorization(method: 'POST' | 'GET', pathWithQuery: string, bodyText: string, config: { mchId: string; serialNo: string; privateKey: string }) {
    const ts = `${Math.floor(Date.now() / 1000)}`;
    const nonce = Math.random().toString(36).slice(2, 18);
    const message = `${method}\n${pathWithQuery}\n${ts}\n${nonce}\n${bodyText}\n`;
    const signer = createSign('RSA-SHA256');
    signer.update(message);
    signer.end();
    const signature = signer.sign(config.privateKey, 'base64');
    return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${ts}",serial_no="${config.serialNo}",signature="${signature}"`;
  }

  private async requestWechat(
    method: 'POST' | 'GET',
    path: string,
    config: { mchId: string; serialNo: string; privateKey: string },
    body?: Record<string, any>,
  ) {
    const bodyText = method === 'POST' ? JSON.stringify(body || {}) : '';
    const auth = this.buildAuthorization(method, path, bodyText, config);
    const url = `https://api.mch.weixin.qq.com${path}`;
    const fetcher: any = (global as any).fetch;
    if (typeof fetcher !== 'function') {
      throw new BadRequestException('当前运行环境不支持 fetch，请升级 Node.js');
    }
    const res = await fetcher(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        Authorization: auth,
        'User-Agent': 'bluecat-miniapp/1.0',
        'Wechatpay-Serial': config.serialNo,
      },
      ...(method === 'POST' ? { body: bodyText } : {}),
    });
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new BadRequestException(data?.message || (method === 'GET' ? '微信支付查询失败' : '微信下单失败'));
    }
    return data;
  }

  private buildPaySign(pkg: string, nonceStr: string, timestamp: string, config: { appId: string; privateKey: string }) {
    const content = `${config.appId}\n${timestamp}\n${nonceStr}\n${pkg}\n`;
    const signer = createSign('RSA-SHA256');
    signer.update(content);
    signer.end();
    return signer.sign(config.privateKey, 'base64');
  }

  async createJsapiPrepay(input: {
    orderNo: string;
    description: string;
    totalFeeFen: number;
    payerOpenid: string;
    notifyUrl?: string;
    useTestAmount?: boolean;
  }) {
    const config = await this.getRuntimeConfig();
    const envMock = String(process.env.WECHAT_PAY_MOCK || '').trim() === '1';
    const useTestAmount = envMock || !!input.useTestAmount;
    const originalTotal = Math.max(1, Math.floor(Number(input.totalFeeFen || 0)));
    const total = useTestAmount ? 1 : originalTotal;
    if (!input.payerOpenid) throw new BadRequestException('缺少微信 payerOpenid');
    const missing: string[] = [];
    if (!config.mchId) missing.push('WECHAT_PAY_MCHID');
    if (!config.appId) missing.push('WECHAT_MINI_APPID/WECHAT_PAY_APPID');
    if (!config.serialNo) missing.push('WECHAT_PAY_SERIAL_NO');
    if (!config.privateKey) missing.push('WECHAT_PAY_PRIVATE_KEY');
    if (!config.apiV3Key) missing.push('WECHAT_PAY_API_V3_KEY');
    if (!config.notifyUrl) missing.push('WECHAT_PAY_NOTIFY_URL');
    if (missing.length) {
      throw new BadRequestException(`微信支付配置不完整：${missing.join(', ')}`);
    }
    if (!config.privateKey.includes('BEGIN PRIVATE KEY')) {
      throw new BadRequestException('WECHAT_PAY_PRIVATE_KEY 格式错误：需要商户API私钥（BEGIN PRIVATE KEY），不是证书内容');
    }
    const notifyUrl = String(input.notifyUrl || config.notifyUrl || '').trim();
    if (!notifyUrl) throw new BadRequestException('缺少 notify_url');

    const data = await this.requestWechat('POST', '/v3/pay/transactions/jsapi', config, {
      mchid: config.mchId,
      appid: config.appId,
      description: useTestAmount
        ? `${String(input.description || '订单支付').slice(0, 20)}(测试)`
        : (input.description || '订单支付'),
      out_trade_no: input.orderNo,
      notify_url: notifyUrl,
      amount: { total, currency: 'CNY' },
      payer: { openid: input.payerOpenid },
    });
    const prepayId = String(data?.prepay_id || '').trim();
    if (!prepayId) throw new BadRequestException('微信预支付失败：未返回 prepay_id');
    const timeStamp = `${Math.floor(Date.now() / 1000)}`;
    const nonceStr = Math.random().toString(36).slice(2, 18);
    const pkg = `prepay_id=${prepayId}`;
    return {
      mock: useTestAmount,
      mockAmountFen: useTestAmount ? total : undefined,
      originalAmountFen: useTestAmount ? originalTotal : undefined,
      params: {
        timeStamp,
        nonceStr,
        package: pkg,
        signType: 'RSA',
        paySign: this.buildPaySign(pkg, nonceStr, timeStamp, { appId: config.appId, privateKey: config.privateKey }),
      },
    };
  }

  async decryptNotifyResource(resource: { ciphertext: string; nonce: string; associated_data?: string }) {
    const config = await this.getRuntimeConfig();
    const key = Buffer.from(config.apiV3Key, 'utf8');
    const nonce = Buffer.from(String(resource?.nonce || ''), 'utf8');
    const cipherBytes = Buffer.from(String(resource?.ciphertext || ''), 'base64');
    const aad = Buffer.from(String(resource?.associated_data || ''), 'utf8');
    if (cipherBytes.length < 16) throw new BadRequestException('微信回调密文格式错误');
    const tag = cipherBytes.subarray(cipherBytes.length - 16);
    const data = cipherBytes.subarray(0, cipherBytes.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    decipher.setAAD(aad);
    const out = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
  }

  async queryTransactionByOutTradeNo(outTradeNo: string) {
    const config = await this.getRuntimeConfig();
    const missing: string[] = [];
    if (!config.mchId) missing.push('WECHAT_PAY_MCHID');
    if (!config.serialNo) missing.push('WECHAT_PAY_SERIAL_NO');
    if (!config.privateKey) missing.push('WECHAT_PAY_PRIVATE_KEY');
    if (missing.length) {
      throw new BadRequestException(`微信支付配置不完整：${missing.join(', ')}`);
    }
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(String(outTradeNo).trim())}?mchid=${encodeURIComponent(config.mchId)}`;
    return this.requestWechat('GET', path, config);
  }
}
