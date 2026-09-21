import { BadRequestException, Body, Controller, ForbiddenException, Post, Req, UseGuards } from '@nestjs/common';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { StaffActivityService } from './staff-activity.service';

@Controller('staff-activity')
export class StaffActivityController {
  constructor(private readonly service: StaffActivityService) {}

  private assertCanRejectLeave(req: any) {
    const user = req?.user || {};
    const userType = String(user?.userType || '').trim().toUpperCase();
    const roleName = String(user?.roleName || '').trim().toUpperCase();
    const permissions = Array.isArray(user?.permissions) ? user.permissions : [];
    if (
      ['SUPER_ADMIN', 'ADMIN'].includes(userType) ||
      ['SUPER_ADMIN', 'CS_MANAGER', 'STORE_MANAGER'].includes(roleName) ||
      permissions.includes('users:staff:leave-reject:button')
    ) return;
    throw new ForbiddenException('仅店长或管理员可以驳回请假');
  }

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

  @Post('admin/leaves/reject-preview')
  @UseGuards(PermissionsGuard)
  @Permissions('users:staff:page', 'users:staff:leave-reject:button')
  rejectLeavePreview(@Req() req: any, @Body() body: { leaveId: number }) {
    this.assertCanRejectLeave(req);
    return this.service.getRejectLeavePreview(Number(body?.leaveId));
  }

  @Post('admin/leaves/reject')
  @UseGuards(PermissionsGuard)
  @Permissions('users:staff:page', 'users:staff:leave-reject:button')
  rejectLeave(@Req() req: any, @Body() body: { leaveId: number; reason: string }) {
    this.assertCanRejectLeave(req);
    return this.service.rejectLeave({
      leaveId: Number(body?.leaveId),
      reviewerId: Number(req?.user?.userId ?? req?.user?.id),
      reason: body?.reason,
    });
  }

  @Post('admin/set-enabled')
  @UseGuards(PermissionsGuard)
  @Permissions('users:staff:edit:button')
  setEnabled(@Body() body: { userId: number; enabled: boolean }) {
    return this.service.setAssessmentEnabled(Number(body?.userId), Boolean(body?.enabled));
  }
}
