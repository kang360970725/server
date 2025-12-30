import { PrismaClient, PermissionType, UserType, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/**
 * 可改的默认账号信息
 */
const DEFAULT_ADMIN = {
    phone: '13800138000',
    password: '123456',
    name: '超级管理员',
};

async function main() {
    const hashed = await bcrypt.hash(DEFAULT_ADMIN.password, 10);

    /**
     * 1) 权限（种子）
     * - 保留你原来的 BUTTON 权限（project/user/order）
     * - 新增我们统一命名的 PAGE 权限（用于页面路由屏蔽）
     */
    const permissions: Array<{
        key: string;
        name: string;
        module: string;
        type: PermissionType;
    }> = [
        // ====== PAGE 权限（路线B：页面访问权限）======
        { key: 'system:role:page', name: '角色管理页', module: 'system', type: PermissionType.PAGE },
        { key: 'system:permission:page', name: '权限管理页', module: 'system', type: PermissionType.PAGE },
        { key: 'system:game-project:page', name: '项目管理页', module: 'system', type: PermissionType.PAGE },

        { key: 'users:page', name: '用户管理页', module: 'users', type: PermissionType.PAGE },
        { key: 'staff-ratings:page', name: '评级管理页', module: 'staff-ratings', type: PermissionType.PAGE },

        { key: 'orders:list:page', name: '订单管理页', module: 'orders', type: PermissionType.PAGE },

        { key: 'staff:my-orders:page', name: '陪玩-我的接单页', module: 'staff', type: PermissionType.PAGE },
        { key: 'staff:workbench:page', name: '陪玩-工作台页', module: 'staff', type: PermissionType.PAGE },

        { key: 'settlements:experience:page', name: '结算-体验单页', module: 'settlements', type: PermissionType.PAGE },
        { key: 'settlements:monthly:page', name: '结算-月结页', module: 'settlements', type: PermissionType.PAGE },

        // ====== 你原来的 BUTTON 权限（先保留，避免历史功能/按钮权限丢失）======
        // 项目管理
        { key: 'project:read', name: '查看项目', module: 'project', type: PermissionType.BUTTON },
        { key: 'project:write', name: '管理项目', module: 'project', type: PermissionType.BUTTON },

        // 用户管理
        { key: 'user:read', name: '查看用户', module: 'user', type: PermissionType.BUTTON },
        { key: 'user:write', name: '管理用户', module: 'user', type: PermissionType.BUTTON },

        // 订单（占位/旧按钮权限）
        { key: 'order:read', name: '查看订单', module: 'order', type: PermissionType.BUTTON },
        { key: 'order:write', name: '管理订单', module: 'order', type: PermissionType.BUTTON },
        { key: 'order:settlement', name: '订单结算', module: 'order', type: PermissionType.BUTTON },
        { key: 'order:payment', name: '订单打款', module: 'order', type: PermissionType.BUTTON },
    ];

    // upsert permissions
    const permissionRecords = [];
    for (const p of permissions) {
        const rec = await prisma.permission.upsert({
            where: { key: p.key },
            update: {
                name: p.name,
                module: p.module,
                type: p.type,
            },
            create: {
                key: p.key,
                name: p.name,
                module: p.module,
                type: p.type,
            },
        });
        permissionRecords.push(rec);
    }

    const permissionIds = permissionRecords.map((p) => p.id);

    /**
     * 2) 角色（种子）
     */
    const financeRole = await prisma.role.upsert({
        where: { name: 'FINANCE_ADMIN' },
        update: { description: '超级管理员' },
        create: { name: 'FINANCE_ADMIN', description: '超级管理员（种子数据）' },
    });

    const csManagerRole = await prisma.role.upsert({
        where: { name: 'CS_MANAGER' },
        update: { description: '客服主管（种子数据）' },
        create: { name: 'CS_MANAGER', description: '客服主管（种子数据）' },
    });

    /**
     * 3) 给角色挂权限
     * 目前沿用你原来的策略：两个种子角色都给全权限，确保能进后台
     */
    await prisma.role.update({
        where: { id: financeRole.id },
        data: {
            permissions: {
                set: permissionIds.map((id) => ({ id })),
            },
        },
    });

    await prisma.role.update({
        where: { id: csManagerRole.id },
        data: {
            permissions: {
                set: permissionIds.map((id) => ({ id })),
            },
        },
    });

    /**
     * 4) 超级管理员用户（绑定财务管理员 role，确保能进后台）
     */
    await prisma.user.upsert({
        where: { phone: DEFAULT_ADMIN.phone },
        update: {
            name: DEFAULT_ADMIN.name,
            password: hashed,
            userType: UserType.SUPER_ADMIN,
            status: UserStatus.ACTIVE,
            roleId: financeRole.id,
            needResetPwd: false,
        },
        create: {
            phone: DEFAULT_ADMIN.phone,
            name: DEFAULT_ADMIN.name,
            password: hashed,
            userType: UserType.SUPER_ADMIN,
            status: UserStatus.ACTIVE,
            roleId: financeRole.id,
            needResetPwd: false,
        },
    });

    console.log('✅ Seed completed.');
    console.log(`✅ Admin phone: ${DEFAULT_ADMIN.phone}`);
    console.log(`✅ Admin password: ${DEFAULT_ADMIN.password}`);
}

main()
    .catch((e) => {
        console.error('❌ Seed failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
