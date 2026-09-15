import { Body, Controller, Get, Logger, Post, Query, Req } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { Public } from '../auth/decorators/public.decorator';
import { miniOk } from './mini.response';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { MemberService } from '../member/member.service';

@ApiTags('mini-auth')
@Controller('mini/auth')
export class MiniAuthController {
  private readonly logger = new Logger(MiniAuthController.name);
  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
    private readonly memberService: MemberService,
  ) {}

  @Public()
  @Post('login')
  @ApiOperation({ summary: '手机号登录' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['phone', 'password'],
      properties: {
        phone: { type: 'string', example: '13800000000' },
        password: { type: 'string', example: '123456' },
      },
    },
  })
  @ApiOkResponse({
    description: '统一返回结构',
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: {
          success: true,
          access_token: 'jwt_token',
          user: { id: 1, phone: '13800000000', name: '用户0000' },
        },
      },
    },
  })
  async login(@Body() body: { phone: string; password: string }) {
    const result = await this.authService.login({
      phone: body?.phone,
      password: body?.password,
    }, { mini: true });
    if ((result as any)?.success && (result as any)?.user?.id) {
      const token = this.authService.refreshAccessToken({
        id: (result as any).user.id,
        phone: (result as any).user.phone,
        name: (result as any).user.name,
      }, { mini: true });
      (result as any).access_token = token.access_token;
      (result as any).expiresInSeconds = token.expiresInSeconds;
    }
    return miniOk(result);
  }

  @Public()
  @Post('wechat-login')
  @ApiOperation({ summary: '微信授权登录' })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: { success: true, access_token: 'jwt_token', openid: 'openid_xxx', user: { id: 1 } },
      },
    },
  })
  async wechatLogin(@Body() body: { code: string }, @Req() req: any) {
    const traceId = `wxlogin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    let stage = 'validate_code';
    let maskedOpenId: string | null = null;
    let userId: number | null = null;
    const log = (level: 'log' | 'warn' | 'error', event: string, extra: Record<string, unknown> = {}) => {
      const payload = JSON.stringify({
        event: `mini_wechat_login_${event}`,
        traceId,
        stage,
        durationMs: Date.now() - startedAt,
        method: req?.method,
        path: req?.originalUrl || req?.url,
        userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 180),
        openIdMasked: maskedOpenId,
        userId,
        ...extra,
      });
      this.logger[level](payload);
    };

    const code = String(body?.code || '').trim();
    log('log', 'started', { hasCode: Boolean(code), codeLength: code.length });
    if (!code) {
      log('warn', 'rejected', { reason: 'missing_code' });
      return miniOk({ success: false, message: '缺少微信登录 code' }, '缺少微信登录 code');
    }

    try {
      stage = 'exchange_wechat_code';
      const wx: any = await this.memberService.exchangeWechatCode(code);
      maskedOpenId = wx?.openId ? `${String(wx.openId).slice(0, 4)}***${String(wx.openId).slice(-4)}` : null;
      log('log', 'wechat_session_ready', { appIdSuffix: String(wx?.appId || '').slice(-6), hasOpenId: Boolean(wx?.openId), hasUnionId: Boolean(wx?.unionId), hasSessionKey: Boolean(wx?.sessionKey) });

      stage = 'find_wechat_binding';
      let user = await this.memberService.findUserByWechatBinding(wx.appId, wx.openId);
      log('log', 'binding_checked', { bindingFound: Boolean(user) });
      if (!user) {
        stage = 'find_pseudo_phone';
        const pseudoPhone = wx.pseudoPhone;
        const exists = await this.prisma.user.findUnique({ where: { phone: pseudoPhone } });
        if (exists) {
          user = exists;
          log('log', 'pseudo_user_reused', { reusedUserId: exists.id });
        } else {
          stage = 'create_user';
          const hashed = await bcrypt.hash(`wx_${wx.openId}_${Date.now()}`, 10);
          user = await this.prisma.user.create({ data: { phone: pseudoPhone, password: hashed, name: `微信用户${wx.openId.slice(-4)}`, userType: 'REGISTERED_USER' } });
          log('log', 'user_created', { createdUserId: user.id });
        }
      }
      userId = Number(user.id);

      stage = 'persist_login_transaction';
      await this.prisma.$transaction(async (tx) => {
        await this.memberService.ensureUserAssets(user.id, tx as any);
        await this.memberService.upsertWechatBinding({ userId: user.id, appId: wx.appId, openId: wx.openId, unionId: wx.unionId, sessionKey: wx.sessionKey }, tx as any);
        await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      });
      log('log', 'login_persisted');

      stage = 'issue_access_token';
      const token = this.authService.refreshAccessToken({ id: user.id, phone: user.phone, name: user.name || `微信用户${user.id}` }, { mini: true });
      stage = 'load_user_profile';
      const profile = await this.authService.getUserWithPermissions(user.id);
      stage = 'completed';
      log('log', 'succeeded', { profileCompleted: Boolean((profile as any)?.profileCompleted), expiresInSeconds: token.expiresInSeconds });
      return miniOk({ success: true, access_token: token.access_token, openid: wx.openId, unionid: wx.unionId || null, user: profile });
    } catch (e: any) {
      log('error', 'failed', {
        errorName: String(e?.name || e?.constructor?.name || 'Error'),
        errorCode: String(e?.code || e?.response?.errorcode || ''),
        causeCode: String(e?.cause?.code || ''),
        causeErrno: String(e?.cause?.errno || ''),
        causeSyscall: String(e?.cause?.syscall || ''),
        causeHost: String(e?.cause?.hostname || '').slice(0, 120),
        causeMessage: String(e?.cause?.message || '').slice(0, 500),
        status: Number(e?.status || e?.statusCode || e?.response?.statusCode || 0) || undefined,
        message: String(e?.message || e?.response?.message || '微信授权失败').slice(0, 500),
        stack: String(e?.stack || '').split('\n').slice(0, 12).join('\n'),
      });
      return miniOk({ success: false, message: e?.message || '微信授权失败', traceId }, e?.message || '微信授权失败');
    }
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取当前用户' })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: { id: 1, phone: '13800000000', name: '用户0000', permissions: [] },
      },
    },
  })
  async me(@Req() req: any) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    const profile = await this.authService.getUserWithPermissions(uid);
    return miniOk(profile);
  }

  @Post('bind-wechat')
  @ApiBearerAuth()
  @ApiOperation({ summary: '当前登录用户绑定微信 openid' })
  async bindWechat(@Req() req: any, @Body() body: { code: string }) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    if (!uid) return miniOk({ success: false, message: '未登录' }, '未登录');
    const code = String(body?.code || '').trim();
    if (!code) return miniOk({ success: false, message: '缺少微信登录 code' }, '缺少微信登录 code');

    let wx: any;
    try {
      wx = await this.memberService.exchangeWechatCode(code);
    } catch (e: any) {
      return miniOk({ success: false, message: e?.message || '微信授权失败' }, e?.message || '微信授权失败');
    }

    try {
      await this.memberService.upsertWechatBinding({
        userId: uid,
        appId: wx.appId,
        openId: wx.openId,
        unionId: wx.unionId,
        sessionKey: wx.sessionKey,
      });
    } catch (e: any) {
      return miniOk({ success: false, message: e?.message || '微信绑定失败' }, e?.message || '微信绑定失败');
    }

    return miniOk({
      success: true,
      appId: wx.appId,
      openidMasked: wx.openId ? `${String(wx.openId).slice(0, 6)}***${String(wx.openId).slice(-4)}` : null,
      unionidMasked: wx.unionId ? `${String(wx.unionId).slice(0, 6)}***${String(wx.unionId).slice(-4)}` : null,
      hasUnionId: Boolean(wx.unionId),
    }, '微信绑定成功');
  }

  @Get('bind-wechat-h5-url')
  @ApiBearerAuth()
  @ApiOperation({ summary: '生成 H5 微信网页授权绑定地址' })
  async getBindWechatH5Url(@Query('redirectUri') redirectUri: string) {
    const uri = String(redirectUri || '').trim();
    if (!uri || !/^https?:\/\//i.test(uri)) {
      return miniOk({ success: false, message: '缺少有效 redirectUri' }, '缺少有效 redirectUri');
    }
    const { appId } = await this.memberService.getWechatH5OauthConfig();
    if (!appId) return miniOk({ success: false, message: '未配置微信网页授权 AppID' }, '未配置微信网页授权 AppID');
    const state = `bind_${Date.now().toString(36)}`;
    const url =
      `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(appId)}` +
      `&redirect_uri=${encodeURIComponent(uri)}` +
      `&response_type=code&scope=snsapi_base&state=${encodeURIComponent(state)}#wechat_redirect`;
    return miniOk({ success: true, url, appId });
  }

  @Post('bind-wechat-h5')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'H5 当前登录用户绑定微信 openid' })
  async bindWechatH5(@Req() req: any, @Body() body: { code: string }) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    if (!uid) return miniOk({ success: false, message: '未登录' }, '未登录');
    const code = String(body?.code || '').trim();
    if (!code) return miniOk({ success: false, message: '缺少微信网页授权 code' }, '缺少微信网页授权 code');
    let wx: any;
    try {
      wx = await this.memberService.exchangeWechatH5OAuthCode(code);
      await this.memberService.upsertWechatBinding({
        userId: uid,
        appId: wx.appId,
        openId: wx.openId,
        unionId: wx.unionId,
        sessionKey: wx.accessToken,
        platform: 'MP' as any,
      });
    } catch (e: any) {
      return miniOk({ success: false, message: e?.message || '微信绑定失败' }, e?.message || '微信绑定失败');
    }
    return miniOk({
      success: true,
      appId: wx.appId,
      openidMasked: wx.openId ? `${String(wx.openId).slice(0, 6)}***${String(wx.openId).slice(-4)}` : null,
    }, '微信绑定成功');
  }

  @Post('refresh')
  @ApiBearerAuth()
  @ApiOperation({ summary: '刷新 access token' })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: { access_token: 'new_jwt_token', expiresInSeconds: 7200 },
      },
    },
  })
  async refresh(@Req() req: any) {
    const token = this.authService.refreshAccessToken(req?.user || {}, { mini: true });
    return miniOk(token);
  }

  @Post('profile-complete')
  @ApiBearerAuth()
  @ApiOperation({ summary: '完善小程序用户资料' })
  async completeProfile(
    @Req() req: any,
    @Body() body: { nickname?: string; avatarUrl?: string; phoneCode?: string },
  ) {
    const uid = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    const result: any = await this.memberService.completeMiniProfile(uid, body || {});
    const finalUserId = Number(result?.userId || uid);
    const profile = await this.authService.getUserWithPermissions(finalUserId);
    const token =
      finalUserId !== uid
        ? this.authService.refreshAccessToken({
            id: finalUserId,
            phone: String((profile as any)?.phone || '').trim(),
            name: String((profile as any)?.name || '').trim(),
          }, { mini: true })
        : null;
    return miniOk({
      ...profile,
      access_token: token?.access_token,
      merged: Boolean(result?.merged),
    }, result?.merged ? '资料已完善，账号已合并' : '资料已完善');
  }
}
