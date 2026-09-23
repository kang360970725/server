import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { MemberBenefitsService } from './member-benefits.service';

@Controller('member/benefits')
export class MemberBenefitsController {
  constructor(private readonly service: MemberBenefitsService) {}

  @Get()
  @Permissions('wallet:member-benefits:page', 'wallet:member-levels:page')
  list(@Query('enabledOnly') enabledOnly?: string) {
    return this.service.listBenefits({ enabledOnly: enabledOnly === 'true' });
  }

  @Post()
  @Permissions('wallet:member-benefits:page', 'wallet:member-levels:page')
  create(@Body() body: any) {
    return this.service.createBenefit(body || {});
  }

  @Patch(':id')
  @Permissions('wallet:member-benefits:page', 'wallet:member-levels:page')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.service.updateBenefit(id, body || {});
  }

  @Delete(':id')
  @Permissions('wallet:member-benefits:page', 'wallet:member-levels:page')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteBenefit(id);
  }

  @Get('levels/config')
  @Permissions('wallet:member-benefits:page', 'wallet:member-levels:page')
  levelConfigs() {
    return this.service.listLevelBenefits();
  }

  @Post('levels/:levelId/config')
  @Permissions('wallet:member-benefits:page', 'wallet:member-levels:page')
  replaceLevelBenefits(@Param('levelId', ParseIntPipe) levelId: number, @Body() body: any) {
    return this.service.replaceLevelBenefits(levelId, Array.isArray(body?.benefits) ? body.benefits : []);
  }

  @Get('users/:userId')
  @Permissions('users:member:page')
  userBenefits(@Param('userId', ParseIntPipe) userId: number, @Query('includeHistory') includeHistory?: string) {
    return this.service.listUserBenefits(userId, { includeHistory: includeHistory === 'true' });
  }

  @Post('grants/:grantId/use')
  @Permissions('users:member:recharge:button')
  useBenefit(@Param('grantId', ParseIntPipe) grantId: number, @Body() body: any, @Req() req: any) {
    return this.service.useBenefit(grantId, body || {}, Number(req?.user?.userId || 0) || undefined);
  }
}
