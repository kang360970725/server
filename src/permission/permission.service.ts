import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionType } from '@prisma/client';

@Injectable()
export class PermissionService {
    constructor(private prisma: PrismaService) {}

    private async ensureServiceOnlineBoardPermissionTree() {
        const workbenchMenu = await this.prisma.permission.upsert({
            where: { key: 'menu:workbench' },
            update: {
                name: '服务者在线看板',
                module: 'menu',
                type: PermissionType.PAGE,
            },
            create: {
                key: 'menu:workbench',
                name: '服务者在线看板',
                module: 'menu',
                type: PermissionType.PAGE,
            },
            select: { id: true },
        });

        const legacyWorkbench = await this.prisma.permission.findUnique({
            where: { key: 'orders:workbench:page' },
            select: { id: true },
        });
        if (legacyWorkbench) {
            await this.prisma.permission.update({
                where: { key: 'orders:workbench:page' },
                data: {
                    name: '服务者在线看板兼容权限',
                    module: 'orders',
                    type: PermissionType.PAGE,
                    parentId: workbenchMenu.id,
                },
            });
        }

        const serviceBoard = await this.prisma.permission.upsert({
            where: { key: 'service:online-board:page' },
            update: {
                name: '服务者在线看板',
                module: 'service',
                type: PermissionType.PAGE,
                parentId: workbenchMenu.id,
            },
            create: {
                key: 'service:online-board:page',
                name: '服务者在线看板',
                module: 'service',
                type: PermissionType.PAGE,
                parentId: workbenchMenu.id,
            },
            select: { id: true },
        });

        const quickOrder = await this.prisma.permission.findUnique({
            where: { key: 'orders:workbench:create:button' },
            select: { id: true },
        });
        if (quickOrder) {
            await this.prisma.permission.update({
                where: { key: 'orders:workbench:create:button' },
                data: {
                    name: '服务者在线看板快捷发单',
                    module: 'orders',
                    type: PermissionType.BUTTON,
                    parentId: serviceBoard.id,
                },
            });
        }
    }

    private async ensureExcellentStaffPermissionTree() {
        const usersMenu = await this.prisma.permission.upsert({
            where: { key: 'menu:users' },
            update: {
                name: '用户管理',
                module: 'menu',
                type: PermissionType.PAGE,
            },
            create: {
                key: 'menu:users',
                name: '用户管理',
                module: 'menu',
                type: PermissionType.PAGE,
            },
            select: { id: true },
        });

        const excellentPage = await this.prisma.permission.upsert({
            where: { key: 'users:excellent-staff:page' },
            update: {
                name: '优秀服务者管理',
                module: 'users',
                type: PermissionType.PAGE,
                parentId: usersMenu.id,
            },
            create: {
                key: 'users:excellent-staff:page',
                name: '优秀服务者管理',
                module: 'users',
                type: PermissionType.PAGE,
                parentId: usersMenu.id,
            },
            select: { id: true },
        });

        await this.prisma.permission.upsert({
            where: { key: 'users:excellent-staff:manage:button' },
            update: {
                name: '维护优秀服务者',
                module: 'users',
                type: PermissionType.BUTTON,
                parentId: excellentPage.id,
            },
            create: {
                key: 'users:excellent-staff:manage:button',
                name: '维护优秀服务者',
                module: 'users',
                type: PermissionType.BUTTON,
                parentId: excellentPage.id,
            },
        });
    }

    private async ensureMemberCouponPermissionTree() {
        const usersMenu = await this.prisma.permission.upsert({
            where: { key: 'menu:users' },
            update: {
                name: '用户管理',
                module: 'menu',
                type: PermissionType.PAGE,
            },
            create: {
                key: 'menu:users',
                name: '用户管理',
                module: 'menu',
                type: PermissionType.PAGE,
            },
            select: { id: true },
        });

        const memberPage = await this.prisma.permission.upsert({
            where: { key: 'users:member:page' },
            update: {
                name: '会员管理',
                module: 'users',
                type: PermissionType.PAGE,
                parentId: usersMenu.id,
            },
            create: {
                key: 'users:member:page',
                name: '会员管理',
                module: 'users',
                type: PermissionType.PAGE,
                parentId: usersMenu.id,
            },
            select: { id: true },
        });

        await this.prisma.permission.upsert({
            where: { key: 'users:member:coupon-grant:button' },
            update: {
                name: '会员手动发券',
                module: 'users',
                type: PermissionType.BUTTON,
                parentId: memberPage.id,
            },
            create: {
                key: 'users:member:coupon-grant:button',
                name: '会员手动发券',
                module: 'users',
                type: PermissionType.BUTTON,
                parentId: memberPage.id,
            },
        });
    }

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
        await this.ensureServiceOnlineBoardPermissionTree();
        await this.ensureExcellentStaffPermissionTree();
        await this.ensureMemberCouponPermissionTree();

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

    async updatePermission(id: number, data: {
        key?: string;
        name?: string;
        module?: string;
        type?: PermissionType;
        parentId?: number | null;
    }) {
        const current = await this.prisma.permission.findUnique({ where: { id } });
        if (!current) throw new BadRequestException('权限不存在');

        const next = this.sanitizePermissionInput({
            key: data.key ?? current.key,
            name: data.name ?? current.name,
            module: data.module ?? current.module,
            type: data.type ?? current.type,
            parentId: data.parentId === undefined ? current.parentId ?? undefined : data.parentId ?? undefined,
        });

        return this.prisma.permission.update({
            where: { id },
            data: {
                key: next.key,
                name: next.name,
                module: next.module,
                type: next.type,
                parentId: data.parentId === undefined ? current.parentId : data.parentId,
            },
        });
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
