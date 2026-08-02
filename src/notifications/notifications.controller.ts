import { Body, Controller, MessageEvent, Post, Req, Sse, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { NotificationsService } from './notifications.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { ListAnnouncementsDto } from './dto/list-announcements.dto';
import { ReadAnnouncementDto } from './dto/read-announcement.dto';
import { ListDutyCsScheduleDto } from './dto/list-duty-cs-schedule.dto';
import { UpsertDutyCsScheduleDto } from './dto/upsert-duty-cs-schedule.dto';
import { DeleteDutyCsScheduleDto } from './dto/delete-duty-cs-schedule.dto';
import { ListDutyCsLeaveDto } from './dto/list-duty-cs-leave.dto';
import { UpsertDutyCsLeaveDto } from './dto/upsert-duty-cs-leave.dto';
import { DeleteDutyCsLeaveDto } from './dto/delete-duty-cs-leave.dto';
import { ClearRealtimeNotificationDto } from './dto/clear-realtime-notification.dto';
import { SendTestRealtimeNotificationDto } from './dto/send-test-realtime-notification.dto';
import { ListMyNotificationsDto } from './dto/list-my-notifications.dto';
import { MarkNotificationReadDto } from './dto/mark-notification-read.dto';
import { Observable } from 'rxjs';

const LEGACY_SYSTEM_ADMIN_PAGE = 'system:role:page';
const ANNOUNCEMENTS_PAGE = 'system:announcements:page';
const DUTY_CS_PAGE = 'system:duty-cs:page';
const NOTIFICATION_TEST_PUSH_PAGE = 'system:notification-test-push:page';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Post('admin/announcements/list')
  @UseGuards(PermissionsGuard)
  @Permissions(ANNOUNCEMENTS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async adminListAnnouncements(@Body() dto: ListAnnouncementsDto) {
    return this.service.adminListAnnouncements(dto);
  }

  @Post('admin/announcements/miniapp-options')
  @UseGuards(PermissionsGuard)
  @Permissions(ANNOUNCEMENTS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async adminListMiniappAnnouncementOptions(@Body() body: { keyword?: string }) {
    return this.service.adminListMiniappAnnouncementOptions(body?.keyword);
  }

  @Post('admin/announcements/create')
  @UseGuards(PermissionsGuard)
  @Permissions(ANNOUNCEMENTS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async adminCreateAnnouncement(@Body() dto: CreateAnnouncementDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.adminCreateAnnouncement(dto, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('admin/announcements/update')
  @UseGuards(PermissionsGuard)
  @Permissions(ANNOUNCEMENTS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async adminUpdateAnnouncement(@Body() dto: UpdateAnnouncementDto) {
    return this.service.adminUpdateAnnouncement(dto);
  }

  @Post('admin/duty-cs/list')
  @UseGuards(PermissionsGuard)
  @Permissions(DUTY_CS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async listDutySchedules(@Body() dto: ListDutyCsScheduleDto) {
    return this.service.listDutySchedules(dto);
  }

  @Post('admin/duty-cs/upsert')
  @UseGuards(PermissionsGuard)
  @Permissions(DUTY_CS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async upsertDutySchedule(@Body() dto: UpsertDutyCsScheduleDto) {
    return this.service.upsertDutySchedule(dto);
  }

  @Post('admin/duty-cs/delete')
  @UseGuards(PermissionsGuard)
  @Permissions(DUTY_CS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async deleteDutySchedule(@Body() dto: DeleteDutyCsScheduleDto) {
    return this.service.deleteDutySchedule(Number(dto.id));
  }

  @Post('admin/duty-cs/leave/list')
  @UseGuards(PermissionsGuard)
  @Permissions(DUTY_CS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async listDutyLeaves(@Body() dto: ListDutyCsLeaveDto) {
    return this.service.listDutyLeaves(dto);
  }

  @Post('admin/duty-cs/leave/upsert')
  @UseGuards(PermissionsGuard)
  @Permissions(DUTY_CS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async upsertDutyLeave(@Body() dto: UpsertDutyCsLeaveDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.upsertDutyLeave(dto, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('admin/duty-cs/leave/delete')
  @UseGuards(PermissionsGuard)
  @Permissions(DUTY_CS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async deleteDutyLeave(@Body() dto: DeleteDutyCsLeaveDto) {
    return this.service.deleteDutyLeave(Number(dto.id));
  }

  @Post('my/announcements')
  async myAnnouncements(@Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.listMyAnnouncements(userId);
  }

  @Post('my/announcements/read')
  async readAnnouncement(@Req() req: any, @Body() dto: ReadAnnouncementDto) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.markAnnouncementRead(userId, Number(dto.announcementId));
  }

  @Post('my/announcements/pending-force')
  async pendingForceAnnouncements(@Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.getMyForceAnnouncementStats(userId);
  }

  @Post('my/list')
  async myNotifications(@Req() req: any, @Body() dto: ListMyNotificationsDto) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.listMyNotifications(userId, dto);
  }

  @Post('my/read')
  async readNotification(@Req() req: any, @Body() dto: MarkNotificationReadDto) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.markMyNotificationRead(userId, dto);
  }

  @Post('my/unread-count')
  async unreadCount(@Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.getMyNotificationUnreadCount(userId);
  }

  @Sse('my/realtime/stream')
  realtimeStream(@Req() req: any): Observable<MessageEvent> {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.subscribeMyRealtimeNotifications(userId);
  }

  @Post('my/realtime/list')
  async myRealtimeList(@Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.listMyRealtimeNotifications(userId);
  }

  @Post('my/realtime/clear-one')
  async clearOneRealtime(@Req() req: any, @Body() dto: ClearRealtimeNotificationDto) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.clearMyRealtimeNotification(userId, dto.id);
  }

  @Post('my/realtime/clear-all')
  async clearAllRealtime(@Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.clearMyAllRealtimeNotifications(userId);
  }

  @Post('admin/test-push/send')
  @UseGuards(PermissionsGuard)
  @Permissions(NOTIFICATION_TEST_PUSH_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async adminSendTestPush(@Body() dto: SendTestRealtimeNotificationDto) {
    return this.service.adminSendTestRealtimePush(dto);
  }
}
