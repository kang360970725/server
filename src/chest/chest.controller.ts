import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ChestService } from './chest.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';

const CHEST_PAGE = 'chest:page';
const LEGACY_ADMIN_PAGE = 'system:role:page';

@Controller('chest')
@UseGuards(JwtAuthGuard)
export class ChestController {
  constructor(private readonly service: ChestService) {}

  private ok(data: any) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const flat: any = { ...data };
      if (Object.prototype.hasOwnProperty.call(flat, 'code')) delete flat.code;
      if (Object.prototype.hasOwnProperty.call(flat, 'message')) delete flat.message;
      return { ...flat, code: 0, message: 'ok', data };
    }
    return { code: 0, message: 'ok', data };
  }

  private fail(message: string) {
    return { code: 1, message, data: null };
  }

  @Get('my/status')
  myStatus(@Req() req: any) {
    return this.service.myStatus(Number(req?.user?.userId || 0));
  }

  @Post('my/redeem')
  redeem(@Req() req: any, @Body() body: { code: string }) {
    return this.service.redeemCode(Number(req?.user?.userId || 0), String(body?.code || ''));
  }

  @Post('my/open')
  open(@Req() req: any, @Body() body: { costKeys?: number }) {
    return this.service.openChest(Number(req?.user?.userId || 0), body?.costKeys);
  }

  @Public()
  @Post('public/status')
  publicStatus(@Body() body: { deviceId: string; phone?: string; code?: string }) {
    return this.service
      .publicStatus(
        String(body?.deviceId || ''),
        body?.phone ? String(body.phone) : undefined,
        body?.code ? String(body.code) : undefined,
      )
      .then((data) => this.ok(data))
      .catch((e: any) => this.fail(e?.message || '获取状态失败'));
  }

  @Public()
  @Post('public/redeem')
  publicRedeem(@Body() body: { deviceId: string; code: string; phone?: string }) {
    return this.service
      .publicRedeem(
        String(body?.deviceId || ''),
        String(body?.code || ''),
        body?.phone ? String(body.phone) : undefined,
      )
      .then((data) => this.ok(data))
      .catch((e: any) => this.fail(e?.message || '兑换失败'));
  }

  @Public()
  @Post('public/open')
  publicOpen(@Body() body: { deviceId: string; costKeys?: number; phone?: string; code?: string }) {
    return this.service
      .publicOpen(
        String(body?.deviceId || ''),
        body?.costKeys,
        body?.phone ? String(body.phone) : undefined,
        body?.code ? String(body.code) : undefined,
      )
      .then((data) => this.ok(data))
      .catch((e: any) => this.fail(e?.message || '开盒失败'));
  }

  @Public()
  @Post('public/history')
  publicHistory(@Body() body: { deviceId: string; page?: number; pageSize?: number; phone?: string; code?: string }) {
    return this.service
      .publicHistory(
        String(body?.deviceId || ''),
        body?.page,
        body?.pageSize,
        body?.phone ? String(body.phone) : undefined,
        body?.code ? String(body.code) : undefined,
      )
      .then((data) => this.ok(data))
      .catch((e: any) => this.fail(e?.message || '查询失败'));
  }

  @Public()
  @Get('public/reward-pool')
  publicRewardPool() {
    return this.service
      .publicRewardPool()
      .then((data) => this.ok(data))
      .catch((e: any) => this.fail(e?.message || '查询失败'));
  }

  @Get('admin/config')
  @UseGuards(PermissionsGuard)
  @Permissions(CHEST_PAGE, LEGACY_ADMIN_PAGE)
  adminGetConfig() {
    return this.service.getConfig();
  }

  @Post('admin/config')
  @UseGuards(PermissionsGuard)
  @Permissions(CHEST_PAGE, LEGACY_ADMIN_PAGE)
  adminUpdateConfig(@Body() body: { enabled?: boolean; title?: string; defaultKeyCount?: number }) {
    return this.service.updateConfig(body || {});
  }

  @Post('admin/codes/generate')
  @UseGuards(PermissionsGuard)
  @Permissions(CHEST_PAGE, LEGACY_ADMIN_PAGE)
  adminGenerateCodes(@Req() req: any, @Body() body: { count: number; keyCount?: number; prefix?: string; expireAt?: string | null }) {
    return this.service.generateCodes(body || ({} as any), Number(req?.user?.userId || 0));
  }

  @Post('admin/codes/list')
  @UseGuards(PermissionsGuard)
  @Permissions(CHEST_PAGE, LEGACY_ADMIN_PAGE)
  adminListCodes(@Body() body: { page?: number; pageSize?: number; status?: 'UNUSED' | 'USED' | 'ALL'; code?: string; phone?: string }) {
    return this.service.listCodes(body || {});
  }

  @Post('admin/codes/redeem')
  @UseGuards(PermissionsGuard)
  @Permissions(CHEST_PAGE, LEGACY_ADMIN_PAGE)
  adminRedeemCode(@Body() body: { code: string; userId?: number; phone?: string }) {
    return this.service.redeemCodeByAdmin(body || ({} as any));
  }

  @Post('admin/codes/history')
  @UseGuards(PermissionsGuard)
  @Permissions(CHEST_PAGE, LEGACY_ADMIN_PAGE)
  adminCodeHistory(@Body() body: { code: string; page?: number; pageSize?: number }) {
    return this.service.getCodeOpenHistory(body || ({} as any));
  }

  @Post('admin/codes/history/verify')
  @UseGuards(PermissionsGuard)
  @Permissions(CHEST_PAGE, LEGACY_ADMIN_PAGE)
  adminVerifyCodeHistory(
    @Req() req: any,
    @Body() body: { recordId: number; verified: boolean; remark?: string },
  ) {
    return this.service.verifyOpenRecord(body || ({} as any), Number(req?.user?.userId || 0));
  }

  @Get('admin/rewards')
  @UseGuards(PermissionsGuard)
  @Permissions(CHEST_PAGE, LEGACY_ADMIN_PAGE)
  adminListRewards() {
    return this.service.listRewardItems();
  }

  @Post('admin/rewards/save')
  @UseGuards(PermissionsGuard)
  @Permissions(CHEST_PAGE, LEGACY_ADMIN_PAGE)
  adminSaveReward(
    @Body()
    body: {
      id?: number;
      name: string;
      type: string;
      quantity?: number;
      weight?: number;
      stock?: number | null;
      enabled?: boolean;
      sortOrder?: number;
    },
  ) {
    return this.service.saveRewardItem(body || ({} as any));
  }

  @Post('admin/rewards/delete')
  @UseGuards(PermissionsGuard)
  @Permissions(CHEST_PAGE, LEGACY_ADMIN_PAGE)
  adminDeleteReward(@Body() body: { id: number }) {
    return this.service.deleteRewardItem(Number(body?.id || 0));
  }
}
