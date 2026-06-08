import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
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

  async validate(payload: any) {
    const userId = Number(payload.sub);
    if (!userId) throw new UnauthorizedException('无效 token');

    // ✅ 这里挂 permissions（Permission.key）
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        phone: true,
        status: true,
        roleId: true,
        userType: true,
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

    const permissions = user.Role?.permissions?.map((p) => p.key) || [];
    const roleName = String(user.Role?.name || '').trim();
    const leaseNow = new Date();
    const leaseExpiresAt = user.workOnlineExpiresAt ? new Date(user.workOnlineExpiresAt) : null;
    const isStaff = String(user.userType || '').toUpperCase() === 'STAFF';
    const isOnline = String(user.workMode || '').toUpperCase() === 'ONLINE';

    if (isStaff && isOnline) {
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
      } else {
        await this.prisma.user.updateMany({
          where: {
            id: user.id,
            userType: 'STAFF',
            workMode: 'ONLINE',
          },
          data: {
            workMode: 'OFFLINE',
            workStatus: 'IDLE',
            offlineJoinedAt: leaseNow,
            workOnlineExpiresAt: null,
          },
        });
        user.workMode = 'OFFLINE';
        user.workStatus = 'IDLE';
        user.offlineJoinedAt = leaseNow;
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
      workStatus: user.workStatus,
      offlineJoinedAt: user.offlineJoinedAt,
      workMode: user.workMode,
      workOnlineExpiresAt: user.workOnlineExpiresAt,
      permissions,
    };
  }
}
