import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionType } from '@prisma/client';

@Injectable()
export class PermissionService {
    constructor(private prisma: PrismaService) {}

    private sanitizePermissionInput(data: {
        key: string;
        name: string;
        module: string;
        type: PermissionType;
        parentId?: number;
    }) {
        const key = String(data?.key || '').trim();
        const name = String(data?.name || '').trim();
        const module = String(data?.module || '').trim();

        if (!key) throw new BadRequestException('权限键不能为空');
        if (!name) throw new BadRequestException('权限名称不能为空');
        if (!module) throw new BadRequestException('模块名称不能为空');

        return {
            ...data,
            key,
            name,
            module,
        };
    }

    async getPermissionTree() {
        const permissions = await this.prisma.permission.findMany({
            orderBy: { id: 'asc' },
        });

        const buildTree = (parentId: number | null) => {
            return permissions
                .filter(permission => permission.parentId === parentId)
                .map(permission => ({
                    ...permission,
                    children: buildTree(permission.id),
                }));
        };

        return buildTree(null);
    }

    async createPermission(data: {
        key: string;
        name: string;
        module: string;
        type: PermissionType;
        parentId?: number;
    }) {
        return this.prisma.permission.create({ data: this.sanitizePermissionInput(data) });
    }

    async deletePermission(id: number) {
        // 删除子权限
        await this.prisma.permission.deleteMany({
            where: { parentId: id },
        });

        return this.prisma.permission.delete({
            where: { id },
        });
    }
}
