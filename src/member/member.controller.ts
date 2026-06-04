import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { MemberService } from './member.service';

@Controller('member')
export class MemberController {
  constructor(private readonly memberService: MemberService) {}

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

  @Get('points/transactions')
  listPointTransactions(
    @Query('userId', ParseIntPipe) userId: number,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.memberService.listPointTransactions(userId, { page, limit });
  }
}
