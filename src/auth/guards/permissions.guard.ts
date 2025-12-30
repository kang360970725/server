// src/auth/guards/permissions.guard.ts
import {
    Injectable,
    CanActivate,
    ExecutionContext,
    ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class PermissionsGuard implements CanActivate {
    constructor(private reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        const requiredPermissions =
            this.reflector.get<string[]>('permissions', context.getHandler()) || [];

        // 没配置权限 => 放行
        if (requiredPermissions.length === 0) return true;

        const request = context.switchToHttp().getRequest();
        const user = request.user as { permissions?: string[] } | undefined;

        const userPermissions = user?.permissions || [];
        const ok = requiredPermissions.some((p) => userPermissions.includes(p));

        if (!ok) {
            // 让前端能收到 403（配合 3.3）
            throw new ForbiddenException('权限不足');
        }

        return true;
    }
}
