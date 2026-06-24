import { Body, Controller, Get, Post, Req } from '@nestjs/common';
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
  async wechatLogin(@Body() body: { code: string }) {
    const code = String(body?.code || '').trim();
    if (!code) return miniOk({ success: false, message: '缺少微信登录 code' }, '缺少微信登录 code');
    let wx: any;
    try {
      wx = await this.memberService.exchangeWechatCode(code);
    } catch (e: any) {
      return miniOk({ success: false, message: e?.message || '微信授权失败' }, e?.message || '微信授权失败');
    }

    let user = await this.memberService.findUserByWechatBinding(wx.appId, wx.openId);
    if (!user) {
      let pseudoPhone = wx.pseudoPhone;
      const exists = await this.prisma.user.findUnique({ where: { phone: pseudoPhone } });
      if (exists) {
        user = exists;
      } else {
        const hashed = await bcrypt.hash(`wx_${wx.openId}_${Date.now()}`, 10);
        user = await this.prisma.user.create({
          data: {
            phone: pseudoPhone,
            password: hashed,
            name: `微信用户${wx.openId.slice(-4)}`,
            userType: 'REGISTERED_USER',
          },
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await this.memberService.ensureUserAssets(user.id, tx as any);
      await this.memberService.upsertWechatBinding({
        userId: user.id,
        appId: wx.appId,
        openId: wx.openId,
        unionId: wx.unionId,
        sessionKey: wx.sessionKey,
      }, tx as any);
      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
    });

    const token = this.authService.refreshAccessToken({
      id: user.id,
      phone: user.phone,
      name: user.name || `微信用户${user.id}`,
    }, { mini: true });
    const profile = await this.authService.getUserWithPermissions(user.id);
    return miniOk({
      success: true,
      access_token: token.access_token,
      openid: wx.openId,
      unionid: wx.unionId || null,
      user: profile,
    });
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
