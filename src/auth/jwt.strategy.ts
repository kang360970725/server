import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
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
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        roleId: true,
        userType: true,
        Role: {
          select: {
            permissions: { select: { key: true } },
          },
        },
      },
    });

    if (!user) throw new UnauthorizedException('用户不存在');

    const permissions = user.Role?.permissions?.map((p) => p.key) || [];

    return {
      id: user.id,
      userId: user.id, // 兼容旧代码（你 controller 里在用 req.user.userId）:contentReference[oaicite:3]{index=3}
      phone: user.phone,
      roleId: user.roleId,
      userType: user.userType,
      permissions,
    };
  }
}
