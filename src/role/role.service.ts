import {BadRequestException, Injectable, NotFoundException} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RoleService {
    constructor(private prisma: PrismaService) {}

    private async normalizePermissionIds(permissionIds?: number[]) {
        const ids = Array.from(
            new Set((permissionIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)),
        );
        if (!ids.length) return [];
        const permissions = await this.prisma.permission.findMany({
            where: {
                id: { in: ids },
                NOT: { key: { startsWith: 'menu:' } },
            },
            select: { id: true, parentId: true },
        });
        const result = new Set(permissions.map((p) => p.id));
        const pendingParentIds = Array.from(
            new Set(permissions.map((p) => p.parentId).filter((id): id is number => Number.isFinite(Number(id)))),
        );

        while (pendingParentIds.length) {
            const parents = await this.prisma.permission.findMany({
                where: { id: { in: pendingParentIds.splice(0) } },
                select: { id: true, key: true, parentId: true },
            });

            for (const parent of parents) {
                if (!parent.key.startsWith('menu:')) {
                    result.add(parent.id);
                }
                if (parent.parentId && !result.has(parent.parentId)) {
                    pendingParentIds.push(parent.parentId);
                }
            }
        }

        return Array.from(result);
    }

    async getRoles() {
        return this.prisma.role.findMany({
            include: {
                permissions: true,
                _count: {
                    select: { users: true }
                }
            }
        });
    }

    async createRole(data: {
        name: string;
        description?: string;
        permissionIds: number[];
    }) {
        const permissionIds = await this.normalizePermissionIds(data.permissionIds);
        return this.prisma.role.create({
            data: {
                name: data.name,
                description: data.description,
                permissions: {
                    connect: permissionIds.map(id => ({ id }))
                }
            },
            include: { permissions: true }
        });
    }

    async updateRole(id: number, data: {
        name?: string;
        description?: string;
        permissionIds?: number[];
    }) {
        const role = await this.prisma.role.findUnique({ where: { id } });
        if (!role) throw new NotFoundException('角色不存在');

        // 移除 permissionIds，只保留需要更新的字段
        const { permissionIds, ...updateData } = data;
        const normalizedPermissionIds = permissionIds ? await this.normalizePermissionIds(permissionIds) : undefined;

        return this.prisma.role.update({
            where: { id },
            data: {
                ...updateData,
                permissions: normalizedPermissionIds ? {
                    set: normalizedPermissionIds.map(id => ({ id }))
                } : undefined
            },
            include: { permissions: true }
        });
    }

    async deleteRole(id: number) {
        const role = await this.prisma.role.findUnique({
            where: { id },
            include: { users: true }
        });

        if (!role) throw new NotFoundException('角色不存在');
        if (role.users.length > 0) {
            throw new BadRequestException('该角色下还有用户，无法删除');
        }

        return this.prisma.role.delete({ where: { id } });
    }
}
