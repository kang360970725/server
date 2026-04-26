import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import * as jwt from 'jsonwebtoken';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    constructor(private readonly reflector: Reflector) {
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
            const refreshedToken = jwt.sign(payload, process.env.JWT_SECRET || 'your-secret-key', {
                expiresIn: '2h',
            });
            const res = context.switchToHttp().getResponse();
            if (res?.setHeader) {
                res.setHeader('x-access-token', refreshedToken);
            }
        }

        return user;
    }
}
