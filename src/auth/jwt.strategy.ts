import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PlayerWorkStatus, StaffEmploymentStatus } from '@prisma/client';
import { isDispatchMonitoredStaff, isStaffUser } from '../common/utils/staff-role-scope.util';
import { StaffRuleEngineService } from '../system-config/staff-rule-engine.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  // 临时策略：仅保留手动离线/登录上线，不再因租约过期自动离线。
  private readonly autoOfflineDisabled = true;

  constructor(
    private prisma: PrismaService,
    private readonly staffRuleEngineService: StaffRuleEngineService,
  ) {
    super({
      // 支持 SSE 场景：EventSource 无法自定义 Authorization header，允许 query.token 透传
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: any) => String(req?.query?.token || '').trim() || null,
      ]),
      ignoreExpiration: false,
      // ✅ 统一从 env 取，避免写死
      secretOrKey: process.env.JWT_SECRET || 'your-secret-key',
    });
  }

  private async autoFreezeDormantStaffIfNeeded(user: any) {
    if (
      String(user?.staffEmploymentStatus || '') === StaffEmploymentStatus.FROZEN &&
      !isDispatchMonitoredStaff(user)
    ) {
      await this.prisma.user.update({
        where: { id: Number(user.id) },
        data: {
          staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
          canWithdraw: true,
        },
      });
      return {
        ...user,
        staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
        canWithdraw: true,
      };
    }
    if (!isDispatchMonitoredStaff(user)) return user;
    if (String(user?.staffEmploymentStatus || StaffEmploymentStatus.ACTIVE) !== StaffEmploymentStatus.ACTIVE) return user;

    const lastAccepted = await this.prisma.orderParticipant.findFirst({
      where: {
        userId: Number(user.id),
        acceptedAt: { not: null },
      },
      orderBy: { acceptedAt: 'desc' },
      select: { acceptedAt: true },
    });

    const lastAcceptedDate = lastAccepted?.acceptedAt ? new Date(lastAccepted.acceptedAt) : null;
    const manualBaseDate = user?.staffDormantFreezeBaseAt ? new Date(user.staffDormantFreezeBaseAt) : null;
    const createdAtDate = user?.createdAt ? new Date(user.createdAt) : null;
    const baseDate =
      (manualBaseDate && !Number.isNaN(manualBaseDate.getTime()) ? manualBaseDate : null) ||
      (lastAcceptedDate && !Number.isNaN(lastAcceptedDate.getTime()) ? lastAcceptedDate : null) ||
      (createdAtDate && !Number.isNaN(createdAtDate.getTime()) ? createdAtDate : null);
    if (!baseDate) return user;

    const staffRuleConfig = await this.staffRuleEngineService.getConfig();
    const dormantFreezeDays = this.staffRuleEngineService.getDormantFreezeDays(staffRuleConfig, user?.staffTags);
    const freezeAt = new Date(baseDate);
    freezeAt.setDate(freezeAt.getDate() + dormantFreezeDays);
    if (freezeAt.getTime() > Date.now()) return user;

    await this.prisma.user.update({
      where: { id: Number(user.id) },
      data: {
        staffEmploymentStatus: StaffEmploymentStatus.FROZEN,
        canWithdraw: false,
        workStatus: PlayerWorkStatus.IDLE,
        workOnlineExpiresAt: null,
      },
    });

    return {
      ...user,
      staffEmploymentStatus: StaffEmploymentStatus.FROZEN,
      canWithdraw: false,
      workStatus: PlayerWorkStatus.IDLE,
      workOnlineExpiresAt: null,
    };
  }

  async validate(payload: any) {
    const userId = Number(payload.sub);
    if (!userId) throw new UnauthorizedException('无效 token');

    // ✅ 这里挂 permissions（Permission.key）
    let user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        phone: true,
        status: true,
        roleId: true,
        userType: true,
        createdAt: true,
        staffEmploymentStatus: true,
        staffDormantFreezeBaseAt: true,
        staffTags: true,
        name: true,
        workStatus: true,
        offlineJoinedAt: true,
        workMode: true,
        workOnlineExpiresAt: true,
        Role: {
          select: {
            name: true,
            permissions: { select: { key: true } },
          },
        },
      },
    });

    if (!user) throw new UnauthorizedException('用户不存在');
    user = await this.autoFreezeDormantStaffIfNeeded(user);
    if (!payload?.mini && isDispatchMonitoredStaff(user) && String(user?.staffEmploymentStatus || '') === StaffEmploymentStatus.FROZEN) {
      const staffRuleConfig = await this.staffRuleEngineService.getConfig();
      throw new ForbiddenException(
        this.staffRuleEngineService.buildDormantFreezeMessage(this.staffRuleEngineService.getDormantFreezeDays(staffRuleConfig, user?.staffTags)),
      );
    }

    const permissions = user.Role?.permissions?.map((p) => p.key) || [];
    const roleName = String(user.Role?.name || '').trim();
    const leaseNow = new Date();
    const leaseExpiresAt = user.workOnlineExpiresAt ? new Date(user.workOnlineExpiresAt) : null;
    const isStaff = isStaffUser(user);
    const isActiveStaff = isStaff && String(user?.staffEmploymentStatus || StaffEmploymentStatus.ACTIVE) === StaffEmploymentStatus.ACTIVE;
    const isOnline = String(user.workMode || '').toUpperCase() === 'ONLINE';

    if (isActiveStaff && isOnline) {
      if (this.autoOfflineDisabled) {
        if (leaseExpiresAt && leaseExpiresAt > leaseNow) {
          const nextExpiresAt = new Date(leaseNow.getTime() + 2 * 60 * 60 * 1000);
          await this.prisma.user.updateMany({
            where: {
              id: user.id,
              userType: 'STAFF',
              workMode: 'ONLINE',
              workOnlineExpiresAt: { gt: leaseNow },
            },
            data: {
              workOnlineExpiresAt: nextExpiresAt,
            },
          });
          user.workOnlineExpiresAt = nextExpiresAt;
        }
      } else if (leaseExpiresAt && leaseExpiresAt > leaseNow) {
        const nextExpiresAt = new Date(leaseNow.getTime() + 2 * 60 * 60 * 1000);
        await this.prisma.user.updateMany({
          where: {
            id: user.id,
            userType: 'STAFF',
            workMode: 'ONLINE',
            workOnlineExpiresAt: { gt: leaseNow },
          },
          data: {
            workOnlineExpiresAt: nextExpiresAt,
          },
        });
        user.workOnlineExpiresAt = nextExpiresAt;
      } else {
        await this.prisma.user.updateMany({
          where: {
            id: user.id,
            userType: 'STAFF',
            workMode: 'ONLINE',
          },
          data: {
            workStatus: 'IDLE',
            workOnlineExpiresAt: null,
          },
        });
        user.workStatus = 'IDLE';
        user.workOnlineExpiresAt = null;
      }
    }

    return {
      id: user.id,
      userId: user.id, // 兼容旧代码（你 controller 里在用 req.user.userId）:contentReference[oaicite:3]{index=3}
      phone: user.phone,
      name: user.name,
      status: user.status,
      roleId: user.roleId,
      roleName,
      userType: user.userType,
      staffEmploymentStatus: user.staffEmploymentStatus,
      workStatus: user.workStatus,
      offlineJoinedAt: user.offlineJoinedAt,
      workMode: user.workMode,
      workOnlineExpiresAt: user.workOnlineExpiresAt,
      permissions,
    };
  }
}
