import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable } from '@nestjs/common';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: 'your-secret-key',
    });
  }

  async validate(payload: any) {
    // ✅ 统一使用 req.user.id
    return {
      id: payload.sub,
      userId: payload.sub, // 兼容旧代码（如果项目里有地方用 userId）
      phone: payload.phone,
    };
  }
}
