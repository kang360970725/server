// src/auth/guards/permissions.guard.ts
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

@Injectable()
export class PermissionsGuard implements CanActivate {
    constructor(private reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        const requiredPermissions = this.reflector.get<string[]>(
            'permissions',
            context.getHandler(),
        );

        if (!requiredPermissions) {
            return true;
        }

        const request = context.switchToHttp().getRequest();
        const user = request.user;

        if (!user || !user.role || !user.role.permissions) {
            return false;
        }

        const userPermissions = user.role.permissions.map(p => p.name);
        return requiredPermissions.some(permission =>
            userPermissions.includes(permission)
        );
    }
}
