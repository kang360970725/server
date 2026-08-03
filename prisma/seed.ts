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
        parentKey?: string;
    }> = [
        // ====== 权限树目录节点（只用于权限管理/角色配置定位，不直接参与业务判断）======
        { key: 'menu:system', name: '系统管理', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:goods', name: '商品管理', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:miniapp-config', name: '小程序功能配置', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:ops', name: '推广运营', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:user-logs', name: '操作日志', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:finance', name: '财务管理', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:staff', name: '陪玩中心', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:workbench', name: '客服工作台', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:orders', name: '订单管理', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:wallet', name: '钱包', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:users', name: '用户管理', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:staff-ratings', name: '评级管理', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:performance', name: '业绩看板', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:penalties', name: '罚单管理', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:hidden', name: '隐藏入口/接口保护', module: 'menu', type: PermissionType.PAGE },
        { key: 'menu:legacy-buttons', name: '历史按钮权限', module: 'menu', type: PermissionType.PAGE },

        // ====== PAGE 权限：与 system-admin 当前真实路由和后端保护接口对齐 ======
        { key: 'system:role:page', name: '角色管理', module: 'system', type: PermissionType.PAGE, parentKey: 'menu:system' },
        { key: 'system:permission:page', name: '权限管理', module: 'system', type: PermissionType.PAGE, parentKey: 'menu:system' },
        { key: 'system:configs:page', name: '基础配置', module: 'system', type: PermissionType.PAGE, parentKey: 'menu:system' },
        { key: 'system:app-versions:page', name: '版本迭代', module: 'system', type: PermissionType.PAGE, parentKey: 'menu:system' },
        { key: 'system:announcements:page', name: '系统公告', module: 'system', type: PermissionType.PAGE, parentKey: 'menu:system' },
        { key: 'system:questionnaires:page', name: '匿名问卷', module: 'system', type: PermissionType.PAGE, parentKey: 'menu:system' },
        { key: 'system:duty-cs:page', name: '当班客服配置', module: 'system', type: PermissionType.PAGE, parentKey: 'menu:system' },
        { key: 'system:notification-test-push:page', name: '测试推送中心', module: 'system', type: PermissionType.PAGE, parentKey: 'menu:system' },
        { key: 'system:game-project:page', name: '商品列表/商品配置', module: 'goods', type: PermissionType.PAGE, parentKey: 'menu:goods' },
        { key: 'miniapp:home:page', name: '首页配置', module: 'miniapp', type: PermissionType.PAGE, parentKey: 'menu:miniapp-config' },
        { key: 'miniapp:protocols:page', name: '协议维护', module: 'miniapp', type: PermissionType.PAGE, parentKey: 'menu:miniapp-config' },
        { key: 'ops:promotion:page', name: '宝盒活动/推广运营', module: 'ops', type: PermissionType.PAGE, parentKey: 'menu:ops' },
        { key: 'chest:page', name: '宝盒活动兼容权限', module: 'ops', type: PermissionType.PAGE, parentKey: 'menu:ops' },
        { key: 'coupons:page', name: '优惠券管理', module: 'coupons', type: PermissionType.PAGE, parentKey: 'menu:ops' },
        { key: 'system:user-logs:page', name: '操作日志', module: 'system', type: PermissionType.PAGE, parentKey: 'menu:user-logs' },
        { key: 'finance:dashboard:view', name: '财务看板', module: 'finance', type: PermissionType.PAGE, parentKey: 'menu:finance' },
        { key: 'finance:records:list', name: '财务明细', module: 'finance', type: PermissionType.PAGE, parentKey: 'menu:finance' },
        { key: 'finance:offline-fees:page', name: '线下费用', module: 'finance', type: PermissionType.PAGE, parentKey: 'menu:finance' },
        { key: 'finance:equipment-rental-fees:page', name: '设备租赁费', module: 'finance', type: PermissionType.PAGE, parentKey: 'menu:finance' },
        { key: 'staff:my-orders:page', name: '我的接单记录', module: 'staff', type: PermissionType.PAGE, parentKey: 'menu:staff' },
        { key: 'staff:workbench:page', name: '打手工作台', module: 'staff', type: PermissionType.PAGE, parentKey: 'menu:staff' },
        { key: 'staff:questionnaires:page', name: '信息采集', module: 'staff', type: PermissionType.PAGE, parentKey: 'menu:staff' },
        { key: 'orders:workbench:page', name: '客服工作台', module: 'orders', type: PermissionType.PAGE, parentKey: 'menu:workbench' },
        { key: 'orders:list:page', name: '订单列表', module: 'orders', type: PermissionType.PAGE, parentKey: 'menu:orders' },
        { key: 'orders:complaints:page', name: '客诉工单', module: 'orders', type: PermissionType.PAGE, parentKey: 'menu:orders' },
        { key: 'orders:detail:page', name: '订单详情', module: 'orders', type: PermissionType.PAGE, parentKey: 'menu:orders' },
        { key: 'orders:workbench:create:button', name: '客服工作台创建订单', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:workbench:page' },
        { key: 'orders:list:create:button', name: '订单列表创建订单', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:list:page' },
        { key: 'orders:list:delete:button', name: '订单列表删除订单', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:list:page' },
        { key: 'orders:detail:receipt:button', name: '订单小票', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:mark-paid:button', name: '确认收款', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:refund:button', name: '订单退款', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:edit:button', name: '编辑订单', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:dispatch:button', name: '派单/改派', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:update-paid:button', name: '修改实付/补收', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:confirm-complete:button', name: '确认结单', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:admin-accept:button', name: '客服代接单', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:archive:button', name: '客服存单', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:complete:button', name: '客服结单', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:rollback-accepted:button', name: '回退到接单中', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:rollback-archived:button', name: '回退到存单', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:update-participants:button', name: '更新参与者', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:settlement-adjust:button', name: '调整结算收益', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:archived-progress-fix:button', name: '修复存单进度', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'orders:detail:recalculate-settlements:button', name: '重算订单结算', module: 'orders', type: PermissionType.BUTTON, parentKey: 'orders:detail:page' },
        { key: 'wallet:overview:page', name: '账户概览', module: 'wallet', type: PermissionType.PAGE, parentKey: 'menu:wallet' },
        { key: 'wallet:member-levels:page', name: '会员等级', module: 'wallet', type: PermissionType.PAGE, parentKey: 'menu:wallet' },
        { key: 'wallet:recharge-plans:page', name: '充值方案', module: 'wallet', type: PermissionType.PAGE, parentKey: 'menu:wallet' },
        { key: 'wallet:transactions:page', name: '流水明细', module: 'wallet', type: PermissionType.PAGE, parentKey: 'menu:wallet' },
        { key: 'wallet:replay-preview:page', name: '单用户预核算', module: 'wallet', type: PermissionType.PAGE, parentKey: 'menu:wallet' },
        { key: 'wallet:withdrawals:page', name: '提现审批/提现记录', module: 'wallet', type: PermissionType.PAGE, parentKey: 'menu:wallet' },
        { key: 'users:member:page', name: '会员管理', module: 'users', type: PermissionType.PAGE, parentKey: 'menu:users' },
        { key: 'users:staff:page', name: '打手管理', module: 'users', type: PermissionType.PAGE, parentKey: 'menu:users' },
        { key: 'users:internal:page', name: '后台人员', module: 'users', type: PermissionType.PAGE, parentKey: 'menu:users' },
        { key: 'users:member:create:button', name: '新增会员', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:member:page' },
        { key: 'users:member:edit:button', name: '编辑会员资料', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:member:page' },
        { key: 'users:member:delete:button', name: '删除会员', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:member:page' },
        { key: 'users:member:recharge:button', name: '会员手动充值', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:member:page' },
        { key: 'users:member:growth-adjust:button', name: '调整会员成长值', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:member:page' },
        { key: 'users:member:game-card:button', name: '维护会员游戏名片', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:member:page' },
        { key: 'users:staff:create:button', name: '新增打手', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:staff:page' },
        { key: 'users:staff:edit:button', name: '编辑打手资料', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:staff:page' },
        { key: 'users:staff:assign-role:button', name: '打手分配角色', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:staff:page' },
        { key: 'users:staff:change-level:button', name: '员工升降级', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:staff:page' },
        { key: 'users:staff:reset-password:button', name: '重置打手密码', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:staff:page' },
        { key: 'users:staff:delete:button', name: '删除打手', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:staff:page' },
        { key: 'users:staff:exit:button', name: '员工退店', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:staff:page' },
        { key: 'users:staff:clear:button', name: '员工清退', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:staff:page' },
        { key: 'users:staff:wallet-stats:button', name: '员工资金统计', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:staff:page' },
        { key: 'users:staff:withdraw-qr-reset:button', name: '重置收款码', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:staff:page' },
        { key: 'users:internal:create:button', name: '新增后台人员', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:internal:page' },
        { key: 'users:internal:edit:button', name: '编辑后台人员资料', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:internal:page' },
        { key: 'users:internal:assign-role:button', name: '后台人员分配角色', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:internal:page' },
        { key: 'users:internal:reset-password:button', name: '重置后台人员密码', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:internal:page' },
        { key: 'users:internal:delete:button', name: '删除后台人员', module: 'users', type: PermissionType.BUTTON, parentKey: 'users:internal:page' },
        { key: 'staff-ratings:page', name: '评级管理', module: 'staff-ratings', type: PermissionType.PAGE, parentKey: 'menu:staff-ratings' },
        { key: 'performance:dashboard:view', name: '业绩看板', module: 'performance', type: PermissionType.PAGE, parentKey: 'menu:performance' },
        { key: 'penalties:page', name: '罚单管理', module: 'penalties', type: PermissionType.PAGE, parentKey: 'menu:penalties' },
        { key: 'penalties:ticket:create', name: '罚单开单', module: 'penalties', type: PermissionType.PAGE, parentKey: 'menu:penalties' },
        { key: 'settlements:experience:page', name: '结算体验单接口', module: 'settlements', type: PermissionType.PAGE, parentKey: 'menu:hidden' },
        { key: 'settlements:monthly:page', name: '结算月结接口', module: 'settlements', type: PermissionType.PAGE, parentKey: 'menu:hidden' },
        { key: 'coupons:user-coupons:list', name: '用户券查询接口', module: 'coupons', type: PermissionType.PAGE, parentKey: 'menu:hidden' },

        // ====== 你原来的 BUTTON 权限（先保留，避免历史功能/按钮权限丢失）======
        // 项目管理
        { key: 'project:read', name: '查看项目', module: 'project', type: PermissionType.BUTTON, parentKey: 'menu:legacy-buttons' },
        { key: 'project:write', name: '管理项目', module: 'project', type: PermissionType.BUTTON, parentKey: 'menu:legacy-buttons' },

        // 用户管理
        { key: 'user:read', name: '查看用户', module: 'user', type: PermissionType.BUTTON, parentKey: 'menu:legacy-buttons' },
        { key: 'user:write', name: '管理用户', module: 'user', type: PermissionType.BUTTON, parentKey: 'menu:legacy-buttons' },

        // 订单（占位/旧按钮权限）
        { key: 'order:read', name: '查看订单', module: 'order', type: PermissionType.BUTTON, parentKey: 'menu:legacy-buttons' },
        { key: 'order:write', name: '管理订单', module: 'order', type: PermissionType.BUTTON, parentKey: 'menu:legacy-buttons' },
        { key: 'order:settlement', name: '订单结算', module: 'order', type: PermissionType.BUTTON, parentKey: 'menu:legacy-buttons' },
        { key: 'order:payment', name: '订单打款', module: 'order', type: PermissionType.BUTTON, parentKey: 'menu:legacy-buttons' },
    ];
    const obsoletePagePermissionKeys = [
        'users:page',
        'dashboard:revenue:page',
        'performance:staff:view',
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
                parentId: null,
            },
            create: {
                key: p.key,
                name: p.name,
                module: p.module,
                type: p.type,
                parentId: null,
            },
        });
        permissionRecords.push(rec);
    }

    const permissionByKey = new Map(permissionRecords.map((p) => [p.key, p]));
    for (const p of permissions) {
        const rec = permissionByKey.get(p.key);
        const parent = p.parentKey ? permissionByKey.get(p.parentKey) : null;
        if (!rec) continue;
        await prisma.permission.update({
            where: { id: rec.id },
            data: { parentId: parent?.id ?? null },
        });
    }

    await prisma.permission.deleteMany({
        where: {
            key: { in: obsoletePagePermissionKeys },
        },
    });

    const permissionIds = permissionRecords
        .filter((p) => !p.key.startsWith('menu:'))
        .map((p) => p.id);

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
