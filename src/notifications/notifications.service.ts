import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationType, UserType } from '@prisma/client';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { ListAnnouncementsDto } from './dto/list-announcements.dto';
import { UpsertDutyCsScheduleDto } from './dto/upsert-duty-cs-schedule.dto';
import { ListDutyCsLeaveDto } from './dto/list-duty-cs-leave.dto';
import { UpsertDutyCsLeaveDto } from './dto/upsert-duty-cs-leave.dto';
import { SendTestRealtimeNotificationDto } from './dto/send-test-realtime-notification.dto';
import { ListMyNotificationsDto } from './dto/list-my-notifications.dto';
import { RealtimeNotificationsService } from './realtime-notifications.service';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeNotificationsService: RealtimeNotificationsService,
  ) {}

  typeAnnouncementAudience(v?: string): 'ADMIN' | 'APPLET' | 'ALL' {
    const val = String(v || 'ALL').toUpperCase();
    if (val === 'ADMIN' || val === 'APPLET' || val === 'ALL') return val;
    throw new BadRequestException('audience 只能是 ADMIN / APPLET / ALL');
  }

  private isAdminPortalUserType(userType: UserType) {
    return ([
      UserType.ADMIN,
      UserType.SUPER_ADMIN,
      UserType.FINANCE,
      UserType.OPERATION,
      UserType.CUSTOMER_SERVICE,
    ] as UserType[]).includes(userType);
  }

  private parseAudience(v?: string): 'ADMIN' | 'APPLET' | 'ALL' {
    return this.typeAnnouncementAudience(v);
  }

  private parseMaybeDate(v?: string) {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('日期格式不正确');
    return d;
  }

  private parseRequiredDate(v: string, fieldLabel: string) {
    const str = String(v || '').trim();
    if (!str) throw new BadRequestException(`${fieldLabel}不能为空`);
    const d = new Date(str);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`${fieldLabel}格式不正确`);
    return d;
  }

  private parseMinuteOfDay(v: string) {
    const str = String(v || '').trim();
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(str);
    if (!m) throw new BadRequestException('时间格式必须为 HH:mm');
    return Number(m[1]) * 60 + Number(m[2]);
  }

  private minuteToText(minute: number) {
    const h = `${Math.floor(minute / 60)}`.padStart(2, '0');
    const m = `${minute % 60}`.padStart(2, '0');
    return `${h}:${m}`;
  }

  // 用 bitmask 表示星期：bit0=周日 ... bit6=周六
  private buildWeekdaysMask(weekdays: number[]) {
    let mask = 0;
    for (const weekday of weekdays) {
      mask |= (1 << weekday);
    }
    return mask;
  }

  private extractWeekdaysFromMask(mask: number, fallbackWeekday?: number) {
    const weekdays: number[] = [];
    for (let i = 0; i <= 6; i += 1) {
      if ((mask & (1 << i)) > 0) weekdays.push(i);
    }
    if (!weekdays.length && Number.isInteger(fallbackWeekday) && (fallbackWeekday as number) >= 0 && (fallbackWeekday as number) <= 6) {
      return [Number(fallbackWeekday)];
    }
    return weekdays;
  }

  async adminListAnnouncements(dto: ListAnnouncementsDto) {
    const page = Math.max(1, Number(dto.page || 1));
    const limit = Math.min(100, Math.max(1, Number(dto.limit || 20)));
    const where: any = {};

    const keyword = String(dto.keyword || '').trim();
    if (keyword) {
      where.OR = [
        { title: { contains: keyword } },
        { content: { contains: keyword } },
      ];
    }

    const [list, total] = await this.prisma.$transaction([
      this.prisma.systemAnnouncement.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ id: 'desc' }],
        include: {
          creator: { select: { id: true, name: true, phone: true } },
        },
      }),
      this.prisma.systemAnnouncement.count({ where }),
    ]);

    return { list, total, page, limit };
  }

  async adminCreateAnnouncement(dto: CreateAnnouncementDto, operatorId?: number) {
    const publishAt = this.parseMaybeDate(dto.publishAt || undefined);
    const expireAt = this.parseMaybeDate(dto.expireAt || undefined);

    if (publishAt && expireAt && publishAt >= expireAt) {
      throw new BadRequestException('发布时间必须早于过期时间');
    }

    const audience = this.parseAudience(dto.audience);

    const created = await this.prisma.systemAnnouncement.create({
      data: {
        title: dto.title,
        content: dto.content,
        audience,
        forceRead: Boolean(dto.forceRead),
        enabled: dto.enabled !== false,
        publishAt,
        expireAt,
        createdBy: operatorId || null,
      },
    });

    // 发布即推送（未来若需要“定时发布自动推送”，可再补 scheduler）
    const now = new Date();
    if (created.enabled && (!created.publishAt || created.publishAt <= now) && (!created.expireAt || created.expireAt > now)) {
      await this.pushAnnouncementToAudience(created);
      await this.prisma.systemAnnouncement.update({
        where: { id: created.id },
        data: { notifiedAt: new Date() },
      });
    }

    return created;
  }

  async adminUpdateAnnouncement(dto: UpdateAnnouncementDto) {
    const row = await this.prisma.systemAnnouncement.findUnique({ where: { id: Number(dto.id) } });
    if (!row) throw new NotFoundException('公告不存在');

    const publishAt = dto.publishAt === undefined ? row.publishAt : this.parseMaybeDate(dto.publishAt || undefined);
    const expireAt = dto.expireAt === undefined ? row.expireAt : this.parseMaybeDate(dto.expireAt || undefined);

    if (publishAt && expireAt && publishAt >= expireAt) {
      throw new BadRequestException('发布时间必须早于过期时间');
    }

    return this.prisma.systemAnnouncement.update({
      where: { id: row.id },
      data: {
        title: dto.title,
        content: dto.content,
        audience: dto.audience ? this.parseAudience(dto.audience) : undefined,
        forceRead: dto.forceRead,
        enabled: dto.enabled,
        publishAt,
        expireAt,
      },
    });
  }

  async listMyAnnouncements(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, userType: true },
    });
    if (!user) throw new NotFoundException('用户不存在');

    const audienceList: Array<'ADMIN' | 'APPLET' | 'ALL'> = this.isAdminPortalUserType(user.userType)
      ? ['ADMIN', 'ALL']
      : ['APPLET', 'ALL'];

    const now = new Date();
    const list = await this.prisma.systemAnnouncement.findMany({
      where: {
        enabled: true,
        audience: { in: audienceList },
        OR: [{ publishAt: null }, { publishAt: { lte: now } }],
        AND: [{ OR: [{ expireAt: null }, { expireAt: { gt: now } }] }],
      },
      orderBy: [{ id: 'desc' }],
      include: {
        reads: {
          where: { userId },
          select: { id: true, readAt: true },
          take: 1,
        },
      },
    });

    return list.map((item) => ({
      ...item,
      isRead: item.reads.length > 0,
      readAt: item.reads[0]?.readAt || null,
      reads: undefined,
    }));
  }

  async markAnnouncementRead(userId: number, announcementId: number) {
    const row = await this.prisma.systemAnnouncement.findUnique({ where: { id: announcementId } });
    if (!row || !row.enabled) throw new NotFoundException('公告不存在或已下线');

    await this.prisma.systemAnnouncementRead.upsert({
      where: {
        announcementId_userId: {
          announcementId,
          userId,
        },
      },
      update: { readAt: new Date() },
      create: {
        announcementId,
        userId,
      },
    });

    return { success: true };
  }

  async getMyForceAnnouncementStats(userId: number) {
    const list = await this.listMyAnnouncements(userId);
    // 按业务要求：强制阅读公告每次进入都要弹窗，不依赖历史已读状态
    const forceUnread = list.filter((x) => Boolean(x.forceRead));
    return {
      unreadForceCount: forceUnread.length,
      list: forceUnread,
    };
  }

  private async resolveAudienceUserIds(audience: 'ADMIN' | 'APPLET' | 'ALL') {
    if (audience === 'ALL') {
      const rows = await this.prisma.user.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true },
      });
      return rows.map((x) => Number(x.id));
    }

    if (audience === 'ADMIN') {
      const rows = await this.prisma.user.findMany({
        where: {
          status: 'ACTIVE',
          userType: {
            in: [
              UserType.ADMIN,
              UserType.SUPER_ADMIN,
              UserType.FINANCE,
              UserType.OPERATION,
              UserType.CUSTOMER_SERVICE,
            ],
          },
        },
        select: { id: true },
      });
      return rows.map((x) => Number(x.id));
    }

    const rows = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        userType: { in: [UserType.STAFF, UserType.REGISTERED_USER] },
      },
      select: { id: true },
    });
    return rows.map((x) => Number(x.id));
  }

  async pushAnnouncementToAudience(announcement: {
    id: number;
    title: string;
    content: string;
    audience: 'ADMIN' | 'APPLET' | 'ALL';
  }) {
    const userIds = await this.resolveAudienceUserIds(announcement.audience);
    if (!userIds.length) return { created: 0 };

    return this.batchCreateNotifications({
      userIds,
      type: NotificationType.SYSTEM_ANNOUNCEMENT,
      title: `系统公告：${announcement.title}`,
      content: `你有新的系统公告，请及时查看：${announcement.title}`,
      payload: {
        announcementId: announcement.id,
        audience: announcement.audience,
      },
    });
  }

  async listDutySchedules(dto: { keyword?: string }) {
    const keyword = String(dto.keyword || '').trim();
    const where: any = {};
    if (keyword) {
      where.user = {
        OR: [
          { phone: { contains: keyword } },
          { name: { contains: keyword } },
          { realName: { contains: keyword } },
        ],
      };
    }

    const rows = await this.prisma.csDutySchedule.findMany({
      where,
      include: {
        user: {
          select: { id: true, phone: true, name: true, realName: true, userType: true, status: true },
        },
      },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }, { id: 'desc' }],
    });

    return rows.map((item) => ({
      ...item,
      weekdays: this.extractWeekdaysFromMask(Number((item as any).weekdaysMask || 0), Number(item.weekday)),
      startTime: this.minuteToText(item.startMinute),
      endTime: this.minuteToText(item.endMinute),
    }));
  }

  async upsertDutySchedule(dto: UpsertDutyCsScheduleDto) {
    const userId = Number(dto.userId);
    const startMinute = this.parseMinuteOfDay(dto.startTime);
    const endMinute = this.parseMinuteOfDay(dto.endTime);
    const rawWeekdays = Array.isArray(dto.weekdays) && dto.weekdays.length
      ? dto.weekdays
      : (dto.weekday === undefined || dto.weekday === null ? [] : [dto.weekday]);
    const weekdays = Array.from(new Set(rawWeekdays.map((x) => Number(x))));
    const weekdaysMask = this.buildWeekdaysMask(weekdays);

    if (!weekdays.length) throw new BadRequestException('weekday/weekdays 至少提供一个');
    if (weekdays.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) {
      throw new BadRequestException('weekday 必须在 0-6 范围');
    }

    if (startMinute === endMinute) {
      throw new BadRequestException('开始时间不能等于结束时间');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, userType: true, status: true },
    });

    if (!user) throw new NotFoundException('用户不存在');
    if (user.userType !== UserType.CUSTOMER_SERVICE) {
      throw new BadRequestException('仅允许配置客服用户为当班客服');
    }

    if (dto.id) {
      const old = await this.prisma.csDutySchedule.findUnique({ where: { id: Number(dto.id) } });
      if (!old) throw new NotFoundException('当班配置不存在');

      return this.prisma.csDutySchedule.update({
        where: { id: old.id },
        data: {
          userId,
          weekday: weekdays[0],
          weekdaysMask,
          startMinute,
          endMinute,
          enabled: dto.enabled !== false,
          remark: dto.remark || null,
        },
      });
    }

    return this.prisma.csDutySchedule.create({
      data: {
        userId,
        weekday: weekdays[0],
        weekdaysMask,
        startMinute,
        endMinute,
        enabled: dto.enabled !== false,
        remark: dto.remark || null,
      },
    });
  }

  async deleteDutySchedule(id: number) {
    const row = await this.prisma.csDutySchedule.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('当班配置不存在');
    await this.prisma.csDutySchedule.delete({ where: { id } });
    return { success: true };
  }

  async listDutyLeaves(dto: ListDutyCsLeaveDto) {
    const keyword = String(dto.keyword || '').trim();
    const where: any = {};
    if (keyword) {
      where.OR = [
        {
          user: {
            OR: [
              { phone: { contains: keyword } },
              { name: { contains: keyword } },
              { realName: { contains: keyword } },
            ],
          },
        },
        {
          substituteUser: {
            OR: [
              { phone: { contains: keyword } },
              { name: { contains: keyword } },
              { realName: { contains: keyword } },
            ],
          },
        },
      ];
    }

    const now = new Date();
    const rows = await this.prisma.csDutyLeave.findMany({
      where,
      include: {
        user: {
          select: { id: true, phone: true, name: true, realName: true, userType: true, status: true },
        },
        substituteUser: {
          select: { id: true, phone: true, name: true, realName: true, userType: true, status: true },
        },
        creator: {
          select: { id: true, phone: true, name: true, realName: true, userType: true, status: true },
        },
      },
      orderBy: [{ startAt: 'desc' }, { id: 'desc' }],
    });

    return rows.map((item) => ({
      ...item,
      isActiveNow: item.enabled && item.startAt <= now && item.endAt > now,
    }));
  }

  async upsertDutyLeave(dto: UpsertDutyCsLeaveDto, operatorId?: number) {
    const userId = Number(dto.userId);
    const substituteUserId = Number(dto.substituteUserId);
    const startAt = this.parseRequiredDate(dto.startAt, 'startAt');
    const endAt = this.parseRequiredDate(dto.endAt, 'endAt');

    if (startAt >= endAt) {
      throw new BadRequestException('休假开始时间必须早于结束时间');
    }

    const [user, substituteUser] = await this.prisma.$transaction([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, userType: true, status: true },
      }),
      this.prisma.user.findUnique({
        where: { id: substituteUserId },
        select: { id: true, userType: true, status: true },
      }),
    ]);

    if (!user) throw new NotFoundException('休假客服不存在');
    if (!substituteUser) throw new NotFoundException('代班客服不存在');

    if (user.userType !== UserType.CUSTOMER_SERVICE) {
      throw new BadRequestException('仅允许客服用户提交休假');
    }
    if (substituteUser.userType !== UserType.CUSTOMER_SERVICE) {
      throw new BadRequestException('代班用户必须是客服');
    }
    if (userId === substituteUserId) {
      throw new BadRequestException('代班客服不能与休假客服相同');
    }

    if (dto.id) {
      const old = await this.prisma.csDutyLeave.findUnique({ where: { id: Number(dto.id) } });
      if (!old) throw new NotFoundException('休假配置不存在');

      const updated = await this.prisma.csDutyLeave.update({
        where: { id: old.id },
        data: {
          userId,
          substituteUserId,
          startAt,
          endAt,
          enabled: dto.enabled !== false,
          reason: dto.reason || null,
          createdBy: operatorId ?? old.createdBy,
        },
      });

      if (updated.enabled) {
        await this.createNotification({
          userId: substituteUserId,
          type: NotificationType.CS_DUTY_SUBSTITUTION,
          title: '代班通知',
          content: `你已被设置为代班客服，代班时间：${startAt.toLocaleString('zh-CN')} - ${endAt.toLocaleString('zh-CN')}。`,
          payload: {
            dutyLeaveId: updated.id,
            userId,
            substituteUserId,
            startAt,
            endAt,
            reason: updated.reason || null,
          },
        });
      }
      return updated;
    }

    const created = await this.prisma.csDutyLeave.create({
      data: {
        userId,
        substituteUserId,
        startAt,
        endAt,
        enabled: dto.enabled !== false,
        reason: dto.reason || null,
        createdBy: operatorId || null,
      },
    });

    if (created.enabled) {
      await this.createNotification({
        userId: substituteUserId,
        type: NotificationType.CS_DUTY_SUBSTITUTION,
        title: '代班通知',
        content: `你已被设置为代班客服，代班时间：${startAt.toLocaleString('zh-CN')} - ${endAt.toLocaleString('zh-CN')}。`,
        payload: {
          dutyLeaveId: created.id,
          userId,
          substituteUserId,
          startAt,
          endAt,
          reason: created.reason || null,
        },
      });
    }

    return created;
  }

  async deleteDutyLeave(id: number) {
    const row = await this.prisma.csDutyLeave.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('休假配置不存在');
    await this.prisma.csDutyLeave.delete({ where: { id } });
    return { success: true };
  }

  async createNotification(input: {
    userId: number;
    type: NotificationType;
    title: string;
    content: string;
    payload?: any;
  }) {
    return this.prisma.userNotification.create({
      data: {
        userId: Number(input.userId),
        type: input.type,
        title: input.title,
        content: input.content,
        payload: input.payload as any,
      },
    });
  }

  async batchCreateNotifications(input: {
    userIds: number[];
    type: NotificationType;
    title: string;
    content: string;
    payload?: any;
  }) {
    const userIds = Array.from(new Set((input.userIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)));
    if (!userIds.length) return { created: 0 };

    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds }, status: 'ACTIVE' },
      select: { id: true },
    });

    if (!users.length) return { created: 0 };

    const now = new Date();
    const data = users.map((u) => ({
      userId: u.id,
      type: input.type,
      title: input.title,
      content: input.content,
      payload: input.payload as any,
      isRead: false,
      createdAt: now,
    }));

    const res = await this.prisma.userNotification.createMany({ data });
    return { created: Number(res.count || 0) };
  }

  async listMyNotifications(userId: number, dto: ListMyNotificationsDto) {
    const page = Math.max(1, Number(dto.page || 1));
    const limit = Math.min(100, Math.max(1, Number(dto.limit || 20)));

    const where: any = { userId };
    if (dto.type) where.type = dto.type as any;

    const [list, total, unreadCount] = await this.prisma.$transaction([
      this.prisma.userNotification.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ id: 'desc' }],
      }),
      this.prisma.userNotification.count({ where }),
      this.prisma.userNotification.count({ where: { userId, isRead: false } }),
    ]);

    return { list, total, page, limit, unreadCount };
  }

  async markMyNotificationRead(userId: number, dto: { notificationId?: number; markAll?: boolean }) {
    if (dto.markAll) {
      await this.prisma.userNotification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true, readAt: new Date() },
      });
      return { success: true };
    }

    const id = Number(dto.notificationId || 0);
    if (!id) throw new BadRequestException('notificationId 必填');

    await this.prisma.userNotification.updateMany({
      where: { id, userId },
      data: { isRead: true, readAt: new Date() },
    });

    return { success: true };
  }

  async getMyNotificationUnreadCount(userId: number) {
    const unreadCount = await this.prisma.userNotification.count({ where: { userId, isRead: false } });
    return { unreadCount };
  }

  private getNowShanghaiWeekdayAndMinute(now = new Date()) {
    const weekday = now.getDay();
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    return { weekday, minuteOfDay };
  }

  private async resolveDutySubstituteUserIds(userIds: number[], now = new Date()) {
    const uniqUserIds = Array.from(new Set((userIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)));
    if (!uniqUserIds.length) return new Map<number, number>();

    const rows = await this.prisma.csDutyLeave.findMany({
      where: {
        enabled: true,
        userId: { in: uniqUserIds },
        startAt: { lte: now },
        endAt: { gt: now },
        substituteUser: {
          userType: UserType.CUSTOMER_SERVICE,
          status: 'ACTIVE',
        },
      },
      select: {
        userId: true,
        substituteUserId: true,
        startAt: true,
        endAt: true,
      },
      orderBy: [{ startAt: 'desc' }, { id: 'desc' }],
    });

    const map = new Map<number, number>();
    for (const row of rows) {
      if (!map.has(row.userId)) {
        map.set(Number(row.userId), Number(row.substituteUserId));
      }
    }
    return map;
  }

  // 是否命中当班：
  // 1) 普通班次：start < end，要求“当天在星期范围内 + 当前分钟在区间内”
  // 2) 跨天班次：start > end，拆为两段判断
  //    - 当天晚间段：当天在星期范围内 && minute >= start
  //    - 次日凌晨段：前一天在星期范围内 && minute < end
  private isDutyScheduleActiveAt(input: {
    weekdaysMask: number;
    fallbackWeekday: number;
    startMinute: number;
    endMinute: number;
    weekday: number;
    minuteOfDay: number;
  }) {
    const weekdays = this.extractWeekdaysFromMask(input.weekdaysMask, input.fallbackWeekday);
    const mask = this.buildWeekdaysMask(weekdays);
    const hasWeekday = (w: number) => (mask & (1 << w)) > 0;

    if (input.startMinute < input.endMinute) {
      return hasWeekday(input.weekday) && input.minuteOfDay >= input.startMinute && input.minuteOfDay < input.endMinute;
    }

    const prevWeekday = (input.weekday + 6) % 7;
    return (
      (hasWeekday(input.weekday) && input.minuteOfDay >= input.startMinute)
      || (hasWeekday(prevWeekday) && input.minuteOfDay < input.endMinute)
    );
  }

  async getOnDutyCustomerServiceUserIds(now = new Date()) {
    const { weekday, minuteOfDay } = this.getNowShanghaiWeekdayAndMinute(now);

    const rows = await this.prisma.csDutySchedule.findMany({
      where: {
        enabled: true,
        user: {
          userType: UserType.CUSTOMER_SERVICE,
          status: 'ACTIVE',
        },
      },
      select: { userId: true, weekday: true, weekdaysMask: true, startMinute: true, endMinute: true },
    });

    const dutyUserIds = Array.from(new Set(
      rows
        .filter((item) => this.isDutyScheduleActiveAt({
          weekdaysMask: Number((item as any).weekdaysMask || 0),
          fallbackWeekday: Number(item.weekday),
          startMinute: Number(item.startMinute),
          endMinute: Number(item.endMinute),
          weekday,
          minuteOfDay,
        }))
        .map((x) => Number(x.userId)),
    ));
    const leaveSubstituteMap = await this.resolveDutySubstituteUserIds(dutyUserIds, now);

    const effectiveUserIds: number[] = [];
    for (const userId of dutyUserIds) {
      effectiveUserIds.push(leaveSubstituteMap.get(userId) || userId);
    }

    return Array.from(new Set(effectiveUserIds));
  }

  async pushDispatchAssigned(input: {
    orderId: number;
    dispatchId: number;
    playerIds: number[];
    autoSerial?: string;
  }) {
    // 实时消息中心：派单后立即推给对应打手（不持久化，仅内存缓存 + SSE）
    this.realtimeNotificationsService.pushToUsers({
      userIds: input.playerIds,
      type: NotificationType.DISPATCH_ASSIGNED,
      title: `待接单：${input.autoSerial || `#${input.orderId}`}`,
      content: `订单已派单，请尽快接单处理。点击可直接进入打手工作台。`,
      route: '/staff/workbench',
      payload: {
        orderId: input.orderId,
        dispatchId: input.dispatchId,
        autoSerial: input.autoSerial || null,
      },
    });

    return this.batchCreateNotifications({
      userIds: input.playerIds,
      type: NotificationType.DISPATCH_ASSIGNED,
      title: `待接单：${input.autoSerial || `#${input.orderId}`}`,
      content: `订单已派单，请尽快接单处理。点击可直接进入打手工作台。`,
      payload: {
        orderId: input.orderId,
        dispatchId: input.dispatchId,
        autoSerial: input.autoSerial || null,
      },
    });
  }

  async pushDispatchArchiveOrCompleteToDutyCs(input: {
    orderId: number;
    dispatchId: number;
    autoSerial?: string;
    status: 'ARCHIVED' | 'COMPLETED';
  }) {
    const csIds = await this.getOnDutyCustomerServiceUserIds();
    if (!csIds.length) return { created: 0 };

    const isArchived = input.status === 'ARCHIVED';
    // 实时消息中心：结单/存单待客服处理时，推给当班客服
    this.realtimeNotificationsService.pushToUsers({
      userIds: csIds,
      type: isArchived ? NotificationType.DISPATCH_ARCHIVED : NotificationType.DISPATCH_COMPLETED,
      title: `${isArchived ? '待处理存单' : '待确认结单'}：${input.autoSerial || `#${input.orderId}`}`,
      content: `订单${isArchived ? '已存单' : '已结单'}，请尽快处理。点击将新开订单详情页。`,
      route: `/orders/${input.orderId}`,
      payload: {
        orderId: input.orderId,
        dispatchId: input.dispatchId,
        autoSerial: input.autoSerial || null,
        status: input.status,
        openInNewTab: true,
      },
    });

    return this.batchCreateNotifications({
      userIds: csIds,
      type: isArchived ? NotificationType.DISPATCH_ARCHIVED : NotificationType.DISPATCH_COMPLETED,
      title: `${isArchived ? '待处理存单' : '待确认结单'}：${input.autoSerial || `#${input.orderId}`}`,
      content: `订单${isArchived ? '已存单' : '已结单'}，请尽快处理。点击将新开订单详情页。`,
      payload: {
        orderId: input.orderId,
        dispatchId: input.dispatchId,
        autoSerial: input.autoSerial || null,
        status: input.status,
      },
    });
  }

  @Cron('0 * * * * *', { timeZone: 'Asia/Shanghai' })
  async cronPushScheduledAnnouncements() {
    const now = new Date();
    const list = await this.prisma.systemAnnouncement.findMany({
      where: {
        enabled: true,
        notifiedAt: null,
        OR: [{ publishAt: null }, { publishAt: { lte: now } }],
        AND: [{ OR: [{ expireAt: null }, { expireAt: { gt: now } }] }],
      },
      select: {
        id: true,
        title: true,
        content: true,
        audience: true,
      },
      take: 100,
      orderBy: [{ id: 'asc' }],
    });

    for (const item of list) {
      try {
        await this.pushAnnouncementToAudience({
          id: item.id,
          title: item.title,
          content: item.content,
          audience: item.audience as any,
        });
        await this.prisma.systemAnnouncement.update({
          where: { id: item.id },
          data: { notifiedAt: new Date() },
        });
      } catch (e) {
        console.error('[announcement][cron-push] failed id=', item.id, e?.message || e);
      }
    }
  }

  subscribeMyRealtimeNotifications(userId: number) {
    return this.realtimeNotificationsService.subscribe(userId);
  }

  listMyRealtimeNotifications(userId: number) {
    const list = this.realtimeNotificationsService.list(userId);
    return { list, unreadCount: list.length };
  }

  clearMyRealtimeNotification(userId: number, id: string) {
    return this.realtimeNotificationsService.clearOne(userId, id);
  }

  clearMyAllRealtimeNotifications(userId: number) {
    return this.realtimeNotificationsService.clearAll(userId);
  }

  async adminSendTestRealtimePush(dto: SendTestRealtimeNotificationDto) {
    const targetUserIds = Array.isArray(dto.targetUserIds)
      ? dto.targetUserIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
      : [];

    let roleMatchedUserIds: number[] = [];
    const targetRole = dto.targetRole || 'BOTH';

    if (targetRole === 'STAFF') {
      const users = await this.prisma.user.findMany({
        where: { status: 'ACTIVE', userType: UserType.STAFF },
        select: { id: true },
      });
      roleMatchedUserIds = users.map((u) => Number(u.id));
    } else if (targetRole === 'CUSTOMER_SERVICE') {
      const users = await this.prisma.user.findMany({
        where: { status: 'ACTIVE', userType: UserType.CUSTOMER_SERVICE },
        select: { id: true },
      });
      roleMatchedUserIds = users.map((u) => Number(u.id));
    } else {
      const users = await this.prisma.user.findMany({
        where: { status: 'ACTIVE', userType: { in: [UserType.STAFF, UserType.CUSTOMER_SERVICE] } },
        select: { id: true },
      });
      roleMatchedUserIds = users.map((u) => Number(u.id));
    }

    const userIds = Array.from(new Set([...roleMatchedUserIds, ...targetUserIds]));
    if (!userIds.length) return { pushed: 0 };

    const mockType = dto.mockType || 'CUSTOM';
    const title = String(dto.title || '').trim() || (mockType === 'DISPATCH_ASSIGNED' ? '你有新的接单通知' : '测试推送');
    const content = String(dto.content || '').trim() || (
      mockType === 'DISPATCH_ASSIGNED'
        ? '测试：订单已派单，请及时接单。'
        : mockType === 'DISPATCH_COMPLETED'
          ? '测试：订单已结单，请客服尽快确认。'
          : mockType === 'DISPATCH_ARCHIVED'
            ? '测试：订单已存单，请客服尽快处理。'
            : '这是一条实时测试推送'
    );
    const route = mockType === 'DISPATCH_ASSIGNED'
      ? '/staff/workbench'
      : mockType === 'DISPATCH_ARCHIVED' || mockType === 'DISPATCH_COMPLETED'
        ? '/orders'
        : mockType === 'CS_DUTY_SUBSTITUTION'
          ? '/system/duty-cs'
          : '/welcome';

    return this.realtimeNotificationsService.pushToUsers({
      userIds,
      type: mockType,
      title,
      content,
      route,
      payload: { source: 'admin-test-push', mockType },
    });
  }
}
