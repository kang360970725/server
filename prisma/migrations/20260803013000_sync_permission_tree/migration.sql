-- Sync admin permission tree for production deploy.
-- menu:* rows are presentation-only tree folders. Role grants should only bind real permissions.

DELETE FROM `_PermissionToRole`
WHERE `A` IN (
  SELECT `id` FROM `Permission`
  WHERE `key` IN ('users:page', 'dashboard:revenue:page', 'performance:staff:view')
);

DELETE FROM `Permission`
WHERE `key` IN ('users:page', 'dashboard:revenue:page', 'performance:staff:view');

INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`) VALUES
('menu:system', '系统管理', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:goods', '商品管理', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:miniapp-config', '小程序功能配置', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:ops', '推广运营', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:user-logs', '操作日志', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:finance', '财务管理', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:staff', '陪玩中心', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:workbench', '客服工作台', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:orders', '订单管理', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:wallet', '钱包', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:users', '用户管理', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:staff-ratings', '评级管理', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:performance', '业绩看板', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:penalties', '罚单管理', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:hidden', '隐藏入口/接口保护', 'menu', 'PAGE', NULL, NOW(), NOW()),
('menu:legacy-buttons', '历史按钮权限', 'menu', 'PAGE', NULL, NOW(), NOW()),
('system:role:page', '角色管理', 'system', 'PAGE', NULL, NOW(), NOW()),
('system:permission:page', '权限管理', 'system', 'PAGE', NULL, NOW(), NOW()),
('system:configs:page', '基础配置', 'system', 'PAGE', NULL, NOW(), NOW()),
('system:app-versions:page', '版本迭代', 'system', 'PAGE', NULL, NOW(), NOW()),
('system:announcements:page', '系统公告', 'system', 'PAGE', NULL, NOW(), NOW()),
('system:questionnaires:page', '匿名问卷', 'system', 'PAGE', NULL, NOW(), NOW()),
('system:duty-cs:page', '当班客服配置', 'system', 'PAGE', NULL, NOW(), NOW()),
('system:notification-test-push:page', '测试推送中心', 'system', 'PAGE', NULL, NOW(), NOW()),
('system:game-project:page', '商品列表/商品配置', 'goods', 'PAGE', NULL, NOW(), NOW()),
('miniapp:home:page', '首页配置', 'miniapp', 'PAGE', NULL, NOW(), NOW()),
('miniapp:protocols:page', '协议维护', 'miniapp', 'PAGE', NULL, NOW(), NOW()),
('ops:promotion:page', '宝盒活动/推广运营', 'ops', 'PAGE', NULL, NOW(), NOW()),
('chest:page', '宝盒活动兼容权限', 'ops', 'PAGE', NULL, NOW(), NOW()),
('coupons:page', '优惠券管理', 'coupons', 'PAGE', NULL, NOW(), NOW()),
('system:user-logs:page', '操作日志', 'system', 'PAGE', NULL, NOW(), NOW()),
('finance:dashboard:view', '财务看板', 'finance', 'PAGE', NULL, NOW(), NOW()),
('finance:records:list', '财务明细', 'finance', 'PAGE', NULL, NOW(), NOW()),
('finance:offline-fees:page', '线下费用', 'finance', 'PAGE', NULL, NOW(), NOW()),
('finance:equipment-rental-fees:page', '设备租赁费', 'finance', 'PAGE', NULL, NOW(), NOW()),
('staff:my-orders:page', '我的接单记录', 'staff', 'PAGE', NULL, NOW(), NOW()),
('staff:workbench:page', '打手工作台', 'staff', 'PAGE', NULL, NOW(), NOW()),
('staff:questionnaires:page', '信息采集', 'staff', 'PAGE', NULL, NOW(), NOW()),
('orders:workbench:page', '客服工作台', 'orders', 'PAGE', NULL, NOW(), NOW()),
('orders:list:page', '订单列表', 'orders', 'PAGE', NULL, NOW(), NOW()),
('orders:complaints:page', '客诉工单', 'orders', 'PAGE', NULL, NOW(), NOW()),
('orders:detail:page', '订单详情', 'orders', 'PAGE', NULL, NOW(), NOW()),
('wallet:overview:page', '账户概览', 'wallet', 'PAGE', NULL, NOW(), NOW()),
('wallet:member-levels:page', '会员等级', 'wallet', 'PAGE', NULL, NOW(), NOW()),
('wallet:recharge-plans:page', '充值方案', 'wallet', 'PAGE', NULL, NOW(), NOW()),
('wallet:transactions:page', '流水明细', 'wallet', 'PAGE', NULL, NOW(), NOW()),
('wallet:replay-preview:page', '单用户预核算', 'wallet', 'PAGE', NULL, NOW(), NOW()),
('wallet:withdrawals:page', '提现审批/提现记录', 'wallet', 'PAGE', NULL, NOW(), NOW()),
('users:member:page', '会员管理', 'users', 'PAGE', NULL, NOW(), NOW()),
('users:staff:page', '打手管理', 'users', 'PAGE', NULL, NOW(), NOW()),
('users:internal:page', '后台人员', 'users', 'PAGE', NULL, NOW(), NOW()),
('staff-ratings:page', '评级管理', 'staff-ratings', 'PAGE', NULL, NOW(), NOW()),
('performance:dashboard:view', '业绩看板', 'performance', 'PAGE', NULL, NOW(), NOW()),
('penalties:page', '罚单管理', 'penalties', 'PAGE', NULL, NOW(), NOW()),
('penalties:ticket:create', '罚单开单', 'penalties', 'PAGE', NULL, NOW(), NOW()),
('settlements:experience:page', '结算体验单接口', 'settlements', 'PAGE', NULL, NOW(), NOW()),
('settlements:monthly:page', '结算月结接口', 'settlements', 'PAGE', NULL, NOW(), NOW()),
('coupons:user-coupons:list', '用户券查询接口', 'coupons', 'PAGE', NULL, NOW(), NOW()),
('project:read', '查看项目', 'project', 'BUTTON', NULL, NOW(), NOW()),
('project:write', '管理项目', 'project', 'BUTTON', NULL, NOW(), NOW()),
('user:read', '查看用户', 'user', 'BUTTON', NULL, NOW(), NOW()),
('user:write', '管理用户', 'user', 'BUTTON', NULL, NOW(), NOW()),
('order:read', '查看订单', 'order', 'BUTTON', NULL, NOW(), NOW()),
('order:write', '管理订单', 'order', 'BUTTON', NULL, NOW(), NOW()),
('order:settlement', '订单结算', 'order', 'BUTTON', NULL, NOW(), NOW()),
('order:payment', '订单打款', 'order', 'BUTTON', NULL, NOW(), NOW())
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `module` = VALUES(`module`),
  `type` = VALUES(`type`),
  `parentId` = NULL,
  `updatedAt` = NOW();

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:system'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN (
  'system:role:page',
  'system:permission:page',
  'system:configs:page',
  'system:app-versions:page',
  'system:announcements:page',
  'system:questionnaires:page',
  'system:duty-cs:page',
  'system:notification-test-push:page'
);

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:goods'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN ('system:game-project:page');

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:miniapp-config'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN ('miniapp:home:page', 'miniapp:protocols:page');

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:ops'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN ('ops:promotion:page', 'chest:page', 'coupons:page');

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:user-logs'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN ('system:user-logs:page');

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:finance'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN (
  'finance:dashboard:view',
  'finance:records:list',
  'finance:offline-fees:page',
  'finance:equipment-rental-fees:page'
);

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:staff'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN ('staff:my-orders:page', 'staff:workbench:page', 'staff:questionnaires:page');

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:workbench'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN ('orders:workbench:page');

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:orders'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN ('orders:list:page', 'orders:complaints:page', 'orders:detail:page');

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:wallet'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN (
  'wallet:overview:page',
  'wallet:member-levels:page',
  'wallet:recharge-plans:page',
  'wallet:transactions:page',
  'wallet:replay-preview:page',
  'wallet:withdrawals:page'
);

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:users'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN ('users:member:page', 'users:staff:page', 'users:internal:page');

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:staff-ratings'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN ('staff-ratings:page');

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:performance'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN ('performance:dashboard:view');

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:penalties'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN ('penalties:page', 'penalties:ticket:create');

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:hidden'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN ('settlements:experience:page', 'settlements:monthly:page', 'coupons:user-coupons:list');

UPDATE `Permission` child JOIN `Permission` parent ON parent.`key` = 'menu:legacy-buttons'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN (
  'project:read',
  'project:write',
  'user:read',
  'user:write',
  'order:read',
  'order:write',
  'order:settlement',
  'order:payment'
);

DELETE ptr FROM `_PermissionToRole` ptr
JOIN `Permission` p ON p.`id` = ptr.`A`
WHERE p.`key` LIKE 'menu:%';

INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT p.`id`, r.`id`
FROM `Permission` p
JOIN `Role` r ON r.`name` IN ('FINANCE_ADMIN', 'CS_MANAGER')
WHERE p.`key` NOT LIKE 'menu:%';
