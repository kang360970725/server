import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import * as jwt from 'jsonwebtoken';
import { AuthService } from '../auth.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    constructor(
        private readonly reflector: Reflector,
    ) {
        super();
    }

    canActivate(context: ExecutionContext) {
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);

        if (isPublic) return true;

        return super.canActivate(context) as any;
    }

    handleRequest(err: any, user: any, info: any, context: ExecutionContext) {
        if (err || !user) {
            return super.handleRequest(err, user, info, context);
        }

        const payload = {
            sub: Number(user?.id || user?.userId),
            phone: String(user?.phone || '').trim(),
            name: String(user?.name || '').trim(),
        };
        if (payload.sub) {
            const req = context.switchToHttp().getRequest();
            const path = String(req?.route?.path || req?.url || '').trim();
            const isMiniRoute = path.startsWith('/mini/') || String(req?.originalUrl || '').startsWith('/mini/');
            const refreshedToken = jwt.sign(payload, process.env.JWT_SECRET || 'your-secret-key', {
                expiresIn: isMiniRoute
                    ? AuthService.MINI_ACCESS_TOKEN_EXPIRES_IN
                    : AuthService.DEFAULT_ACCESS_TOKEN_EXPIRES_IN,
            });
            const res = context.switchToHttp().getResponse();
            if (res?.setHeader) {
                res.setHeader('x-access-token', refreshedToken);
            }
        }

        return user;
    }
}
