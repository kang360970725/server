import { Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { MemberService } from './member.service';
import { Permissions } from '../auth/decorators/permissions.decorator';

@Controller('member')
export class MemberController {
  constructor(private readonly memberService: MemberService) {}

  private assertButtonPermission(req: any, key: string, message = '当前角色无权执行该操作') {
    const user = req?.user || {};
    const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
    if (user?.userType === 'SUPER_ADMIN' || permissions.includes(key)) {
      return;
    }
    throw new ForbiddenException(message);
  }

  @Get('recharge-plans')
  listRechargePlans() {
    return this.memberService.listRechargePlans(false);
  }

  @Get('levels')
  listLevelConfigs() {
    return this.memberService.listLevelConfigs();
  }

  @Post('levels')
  createLevelConfig(@Body() body: any) {
    return this.memberService.createLevelConfig(body || {});
  }

  @Patch('levels/:id')
  updateLevelConfig(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.memberService.updateLevelConfig(id, body || {});
  }

  @Post('levels/refresh')
  refreshLevels() {
    return this.memberService.refreshMemberLevels();
  }

  @Post('recharge-plans')
  createRechargePlan(@Body() body: any) {
    return this.memberService.createRechargePlan(body || {});
  }

  @Patch('recharge-plans/:id')
  updateRechargePlan(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.memberService.updateRechargePlan(id, body || {});
  }

  @Post('points/adjust')
  adjustPoints(@Body() body: any) {
    return this.memberService.adjustPoints({
      userId: Number(body?.userId || 0),
      points: Number(body?.points || 0),
      remark: body?.remark ? String(body.remark) : undefined,
    });
  }

  @Post('growth/adjust')
  @Permissions('users:member:growth-adjust:button')
  adjustGrowth(@Req() req: any, @Body() body: any) {
    this.assertButtonPermission(req, 'users:member:growth-adjust:button', '当前角色无权调整会员成长值');
    return this.memberService.adjustGrowth({
      userId: Number(body?.userId || 0),
      growthValue: Number(body?.growthValue || 0),
      remark: body?.remark ? String(body.remark) : undefined,
    });
  }

  @Post('recharge/manual')
  @Permissions('users:member:recharge:button')
  manualRecharge(@Req() req: any, @Body() body: any) {
    this.assertButtonPermission(req, 'users:member:recharge:button', '当前角色无权进行会员手动充值');
    return this.memberService.manualRecharge({
      userId: Number(body?.userId || 0),
      planId: body?.planId != null && body?.planId !== '' ? Number(body.planId) : undefined,
      amount: body?.amount != null && body?.amount !== '' ? Number(body.amount) : undefined,
      bonusAmount: body?.bonusAmount != null && body?.bonusAmount !== '' ? Number(body.bonusAmount) : undefined,
      giftPoints: body?.giftPoints != null && body?.giftPoints !== '' ? Number(body.giftPoints) : undefined,
      giftGrowthValue: body?.giftGrowthValue != null && body?.giftGrowthValue !== '' ? Number(body.giftGrowthValue) : undefined,
      couponBenefits: Array.isArray(body?.couponBenefits) ? body.couponBenefits : undefined,
      remark: body?.remark ? String(body.remark) : undefined,
    }, Number(req?.user?.userId || 0) || undefined);
  }

  @Get('points/transactions')
  listPointTransactions(
    @Query('userId', ParseIntPipe) userId: number,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.memberService.listPointTransactions(userId, { page, limit });
  }
}
