import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RoleService {
    constructor(private prisma: PrismaService) {}

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
        return this.prisma.role.create({
            data: {
                name: data.name,
                description: data.description,
                permissions: {
                    connect: data.permissionIds.map(id => ({ id }))
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

        return this.prisma.role.update({
            where: { id },
            data: {
                ...updateData,
                permissions: permissionIds ? {
                    set: permissionIds.map(id => ({ id }))
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
            throw new Error('该角色下还有用户，无法删除');
        }

        return this.prisma.role.delete({ where: { id } });
    }
}
