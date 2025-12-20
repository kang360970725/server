import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionType } from '@prisma/client';

@Injectable()
export class PermissionService {
    constructor(private prisma: PrismaService) {}

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
        return this.prisma.permission.create({ data });
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
