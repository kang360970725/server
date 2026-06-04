import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { MemberService } from '../member/member.service';
import { miniOk } from './mini.response';
import { WechatPayService } from './wechat-pay.service';
import { getWechatRechargeNotifyUrlFromConfig } from './wechat-callback.util';
import { SystemConfigService } from '../system-config/system-config.service';

@Controller('mini/member')
export class MiniMemberController {
  constructor(
    private readonly memberService: MemberService,
    private readonly wechatPayService: WechatPayService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  @Get('overview')
  async overview(@Req() req: any) {
    const userId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
    return miniOk(await this.memberService.getMiniOverview(userId));
  }

  @Get('recharge-plans')
  async rechargePlans() {
    const plans = await this.memberService.listRechargePlans(true);
    return miniOk(plans.map((item: any) => ({
      ...item,
      amount: Number(item.amount ?? 0),
      bonusAmount: Number(item.bonusAmount ?? 0),
      totalAmount: Number((Number(item.amount ?? 0) + Number(item.bonusAmount ?? 0)).toFixed(2)),
    })));
  }

  @Get('points/transactions')
  async pointTransactions(@Req() req: any, @Query() query: any) {
    const userId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
    return miniOk(await this.memberService.listPointTransactions(userId, query || {}));
  }

  @Post('wechat-bind')
  async wechatBind(@Req() req: any, @Body() body: { code: string }) {
    const userId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
    const code = String(body?.code || '').trim();
    if (!code) throw new BadRequestException('缺少微信登录 code');
    const wx = await this.memberService.exchangeWechatCode(code);
    const binding = await this.memberService.upsertWechatBinding({
      userId,
      appId: wx.appId,
      openId: wx.openId,
      unionId: wx.unionId,
      sessionKey: wx.sessionKey,
    });
    return miniOk({
      bindingId: binding.id,
      openid: binding.openId,
      unionId: binding.unionId,
      lastBindAt: binding.lastBindAt,
    }, '绑定成功');
  }

  @Post('recharge/create')
  async createRechargeOrder(@Req() req: any, @Body() body: { planId?: number; amount?: number; payerOpenid?: string }) {
    const userId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
    await this.memberService.assertMiniPhoneBound(userId);
    return miniOk(await this.memberService.createRechargeOrder(userId, body || {}));
  }

  @Post('recharge/:id/wechat-prepay')
  async createRechargePrepay(@Req() req: any, @Param('id', ParseIntPipe) id: number, @Body() body: any) {
    const userId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
    const notifyUrl = body?.notifyUrl
      ? String(body.notifyUrl).trim()
      : await getWechatRechargeNotifyUrlFromConfig(this.systemConfigService);
    return miniOk(await this.memberService.createRechargePrepay(userId, id, {
      ...(body || {}),
      notifyUrl,
    }));
  }

  @Get('wechat/debug/config')
  async wechatDebugConfig() {
    const rechargeNotifyUrl = await getWechatRechargeNotifyUrlFromConfig(this.systemConfigService);
    return miniOk({
      ...(await this.wechatPayService.getConfigStatus()),
      rechargeNotifyUrl,
    });
  }

  @Public()
  @Post('recharge/wechat/notify')
  async rechargeWechatNotify(@Body() body: any) {
    try {
      const resource = body?.resource;
      if (!resource) return { code: 'FAIL', message: 'resource missing' };
      const decrypted = await this.wechatPayService.decryptNotifyResource(resource);
      const tradeState = String(decrypted?.trade_state || '').toUpperCase();
      const outTradeNo = String(decrypted?.out_trade_no || '').trim();
      if (!outTradeNo) return { code: 'FAIL', message: 'out_trade_no missing' };
      if (tradeState === 'SUCCESS') {
        await this.memberService.settleRechargeSuccess(outTradeNo, {
          transactionId: String(decrypted?.transaction_id || ''),
          payerOpenid: String(decrypted?.payer?.openid || ''),
          notifyRaw: decrypted,
        });
      }
      return { code: 'SUCCESS', message: '成功' };
    } catch (e: any) {
      return { code: 'FAIL', message: e?.message || 'notify handle failed' };
    }
  }
}
