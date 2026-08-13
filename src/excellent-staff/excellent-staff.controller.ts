import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ExcellentStaffService } from './excellent-staff.service';

@Controller('excellent-staff')
@UseGuards(PermissionsGuard)
export class ExcellentStaffController {
  constructor(private readonly excellentStaffService: ExcellentStaffService) {}

  @Post('list')
  @Permissions('users:excellent-staff:page')
  list(@Body() body: any) {
    return this.excellentStaffService.list({
      page: Number(body?.page || 1),
      limit: Number(body?.limit || 20),
      keyword: body?.keyword,
      status: body?.status,
    });
  }

  @Post('candidates')
  @Permissions('users:excellent-staff:page', 'users:excellent-staff:manage:button')
  candidates(@Body() body: any) {
    return this.excellentStaffService.candidates({
      keyword: body?.keyword,
      limit: Number(body?.limit || 50),
    });
  }

  @Post('add')
  @Permissions('users:excellent-staff:manage:button')
  add(@Body() body: any, @Req() req: any) {
    return this.excellentStaffService.add(body?.userIds, Number(req?.user?.userId || 0) || undefined, body?.remark);
  }

  @Post('remove')
  @Permissions('users:excellent-staff:manage:button')
  remove(@Body() body: any, @Req() req: any) {
    return this.excellentStaffService.remove(body?.userIds, Number(req?.user?.userId || 0) || undefined, body?.remark);
  }
}
