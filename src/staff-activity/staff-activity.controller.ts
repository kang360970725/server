import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { StaffActivityService } from './staff-activity.service';

@Controller('staff-activity')
export class StaffActivityController {
  constructor(private readonly service: StaffActivityService) {}

  @Post('my/overview')
  myOverview(@Req() req: any) {
    return this.service.getMyOverview(Number(req?.user?.userId ?? req?.user?.id));
  }

  @Post('my/leave')
  createLeave(@Req() req: any, @Body() body: { days: number; reason?: string }) {
    const days = Number(body?.days);
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new BadRequestException('请假天数必须为1-60天');
    return this.service.createLeave(Number(req?.user?.userId ?? req?.user?.id), days, body?.reason);
  }

  @Post('my/leaves')
  myLeaves(@Req() req: any, @Body() body: any) {
    return this.service.listLeaves({ ...body, userId: Number(req?.user?.userId ?? req?.user?.id) });
  }

  @Post('my/charges')
  myCharges(@Req() req: any, @Body() body: any) {
    return this.service.listCharges({ ...body, userId: Number(req?.user?.userId ?? req?.user?.id) });
  }

  @Post('admin/leaves')
  @UseGuards(PermissionsGuard)
  @Permissions('users:staff:page')
  adminLeaves(@Body() body: any) {
    return this.service.listLeaves(body || {});
  }

  @Post('admin/charges')
  @UseGuards(PermissionsGuard)
  @Permissions('users:staff:page')
  adminCharges(@Body() body: any) {
    return this.service.listCharges(body || {});
  }

  @Post('admin/stats')
  @UseGuards(PermissionsGuard)
  @Permissions('users:staff:page')
  adminStats() {
    return this.service.getTodayStats();
  }

  @Post('admin/set-enabled')
  @UseGuards(PermissionsGuard)
  @Permissions('users:staff:edit:button')
  setEnabled(@Body() body: { userId: number; enabled: boolean }) {
    return this.service.setAssessmentEnabled(Number(body?.userId), Boolean(body?.enabled));
  }
}
