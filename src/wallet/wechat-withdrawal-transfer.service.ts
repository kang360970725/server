import { BadRequestException, Injectable } from '@nestjs/common';
import { createSign } from 'crypto';
import { PrismaService } from '../prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';

type WechatTransferStatus = 'PROCESSING' | 'WAIT_USER_CONFIRM' | 'SUCCESS' | 'FAILED' | 'CANCELLED';

@Injectable()
export class WechatWithdrawalTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  private async getRuntimeConfig() {
    const mchId = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_PAY_MCHID,
      String(process.env.WECHAT_PAY_MCHID || '').trim(),
    );
    const miniAppId = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_MINI_APPID,
      String(process.env.WECHAT_PAY_APPID || '').trim(),
    );
    const transferAppId = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_TRANSFER_APPID,
      String(process.env.WECHAT_TRANSFER_APPID || '').trim(),
    );
    const appId = transferAppId || miniAppId;
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
    const sceneId = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_TRANSFER_SCENE_ID,
      String(process.env.WECHAT_TRANSFER_SCENE_ID || '').trim(),
    );
    const notifyUrl = await this.systemConfigService.getString(
      SystemConfigService.KEYS.WECHAT_TRANSFER_NOTIFY_URL,
      String(process.env.WECHAT_TRANSFER_NOTIFY_URL || '').trim(),
    );
    const mock =
      String(process.env.WECHAT_TRANSFER_MOCK || '').trim() === '1' ||
      (await this.systemConfigService.getBoolean(SystemConfigService.KEYS.WITHDRAW_WECHAT_TRANSFER_MOCK, false));
    return { mchId, appId, serialNo, privateKey, sceneId, notifyUrl, mock };
  }

  async getConfigStatus() {
    const cfg = await this.getRuntimeConfig();
    return {
      mchId: !!cfg.mchId,
      appId: !!cfg.appId,
      serialNo: !!cfg.serialNo,
      privateKey: !!cfg.privateKey,
      privateKeyFormatOk: cfg.privateKey.includes('BEGIN PRIVATE KEY'),
      sceneId: !!cfg.sceneId,
      notifyUrl: !!cfg.notifyUrl,
      mock: cfg.mock,
      ready: cfg.mock || !!(cfg.mchId && cfg.appId && cfg.serialNo && cfg.privateKey && cfg.sceneId),
    };
  }

  async getReceiverOpenid(userId: number) {
    const cfg = await this.getRuntimeConfig();
    if (!cfg.appId) throw new BadRequestException('微信小程序 AppID 未配置，无法匹配收款 openid');
    const binding = await this.prisma.userWechatBinding.findFirst({
      where: {
        userId: Number(userId),
        appId: cfg.appId,
      },
      orderBy: [{ lastBindAt: 'desc' }, { id: 'desc' }],
      select: { openId: true },
    });
    const openid = String(binding?.openId || '').trim();
    if (!openid) throw new BadRequestException('服务者未绑定当前小程序微信 openid，无法自动打款');
    return openid;
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

  private async requestWechat(method: 'POST' | 'GET', path: string, config: { mchId: string; serialNo: string; privateKey: string }, body?: Record<string, any>) {
    const bodyText = method === 'POST' ? JSON.stringify(body || {}) : '';
    const auth = this.buildAuthorization(method, path, bodyText, config);
    const fetcher: any = (global as any).fetch;
    if (typeof fetcher !== 'function') {
      throw new BadRequestException('当前运行环境不支持 fetch，请升级 Node.js');
    }
    const res = await fetcher(`https://api.mch.weixin.qq.com${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        Authorization: auth,
        'User-Agent': 'bluecat-withdrawal/1.0',
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
      throw new BadRequestException(data?.message || data?.code || '微信商家转账请求失败');
    }
    return data;
  }

  private normalizeTransferStatus(rawStatus?: string): WechatTransferStatus {
    const status = String(rawStatus || '').trim().toUpperCase();
    if (['SUCCESS', 'FINISHED'].includes(status)) return 'SUCCESS';
    if (['WAIT_USER_CONFIRM', 'WAIT_USER_RECEIVE'].includes(status)) return 'WAIT_USER_CONFIRM';
    if (['FAIL', 'FAILED'].includes(status)) return 'FAILED';
    if (['CANCELING', 'CANCELLED', 'CANCELED'].includes(status)) return 'CANCELLED';
    return 'PROCESSING';
  }

  async createTransfer(input: {
    userId: number;
    requestNo: string;
    outBillNo: string;
    amountFen: number;
    remark?: string | null;
  }) {
    const cfg = await this.getRuntimeConfig();
    const amountFen = Math.max(1, Math.floor(Number(input.amountFen || 0)));
    const outBillNo = String(input.outBillNo || '').trim();
    if (!outBillNo) throw new BadRequestException('缺少微信提现平台出款单号');

    if (cfg.mock) {
      return {
        mock: true,
        outBillNo,
        transferBillNo: `MOCK${Date.now()}`,
        status: 'SUCCESS' as WechatTransferStatus,
        raw: { mock: true, out_bill_no: outBillNo, amount: amountFen },
      };
    }

    const missing: string[] = [];
    if (!cfg.mchId) missing.push('WECHAT_PAY_MCHID');
    if (!cfg.appId) missing.push('WECHAT_MINI_APPID/WECHAT_PAY_APPID');
    if (!cfg.serialNo) missing.push('WECHAT_PAY_SERIAL_NO');
    if (!cfg.privateKey) missing.push('WECHAT_PAY_PRIVATE_KEY');
    if (!cfg.sceneId) missing.push('WECHAT_TRANSFER_SCENE_ID');
    if (missing.length) throw new BadRequestException(`微信商家转账配置不完整：${missing.join(', ')}`);
    if (!cfg.privateKey.includes('BEGIN PRIVATE KEY')) {
      throw new BadRequestException('WECHAT_PAY_PRIVATE_KEY 格式错误：需要商户API私钥（BEGIN PRIVATE KEY）');
    }

    const openid = await this.getReceiverOpenid(input.userId);
    const body: any = {
      appid: cfg.appId,
      out_bill_no: outBillNo,
      transfer_scene_id: cfg.sceneId,
      openid,
      transfer_amount: amountFen,
      transfer_remark: String(input.remark || `提现${input.requestNo}`).trim().slice(0, 32),
    };
    if (cfg.notifyUrl) body.notify_url = cfg.notifyUrl;

    const data = await this.requestWechat('POST', '/v3/fund-app/mch-transfer/transfer-bills', cfg, body);
    const transferBillNo = String(data?.transfer_bill_no || data?.transferBillNo || '').trim();
    return {
      mock: false,
      outBillNo,
      transferBillNo,
      status: this.normalizeTransferStatus(data?.state || data?.status),
      raw: data,
    };
  }

  async queryTransfer(outBillNo: string) {
    const cfg = await this.getRuntimeConfig();
    const billNo = String(outBillNo || '').trim();
    if (!billNo) throw new BadRequestException('缺少微信提现平台出款单号');
    if (cfg.mock) {
      return {
        mock: true,
        outBillNo: billNo,
        transferBillNo: `MOCK${billNo}`,
        status: 'SUCCESS' as WechatTransferStatus,
        raw: { mock: true, out_bill_no: billNo },
      };
    }
    const missing: string[] = [];
    if (!cfg.mchId) missing.push('WECHAT_PAY_MCHID');
    if (!cfg.serialNo) missing.push('WECHAT_PAY_SERIAL_NO');
    if (!cfg.privateKey) missing.push('WECHAT_PAY_PRIVATE_KEY');
    if (missing.length) throw new BadRequestException(`微信商家转账配置不完整：${missing.join(', ')}`);

    const path = `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${encodeURIComponent(billNo)}`;
    const data = await this.requestWechat('GET', path, cfg);
    return {
      mock: false,
      outBillNo: billNo,
      transferBillNo: String(data?.transfer_bill_no || data?.transferBillNo || '').trim(),
      status: this.normalizeTransferStatus(data?.state || data?.status),
      raw: data,
    };
  }
}
