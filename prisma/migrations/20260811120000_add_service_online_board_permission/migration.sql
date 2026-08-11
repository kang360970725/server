-- 服务者在线看板独立页面权限。

UPDATE `Permission`
SET `name` = '服务者在线看板',
    `updatedAt` = NOW()
WHERE `key` = 'menu:workbench';

UPDATE `Permission`
SET `name` = '服务者在线看板兼容权限',
    `updatedAt` = NOW()
WHERE `key` = 'orders:workbench:page';

INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`)
SELECT 'service:online-board:page',
       '服务者在线看板',
       'service',
       'PAGE',
       parent.`id`,
       NOW(),
       NOW()
FROM `Permission` parent
WHERE parent.`key` = 'menu:workbench'
  AND NOT EXISTS (
    SELECT 1
    FROM `Permission` p
    WHERE p.`key` = 'service:online-board:page'
  );

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'menu:workbench'
SET child.`name` = '服务者在线看板',
    child.`module` = 'service',
    child.`type` = 'PAGE',
    child.`parentId` = parent.`id`,
    child.`updatedAt` = NOW()
WHERE child.`key` = 'service:online-board:page';

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'service:online-board:page'
SET child.`name` = '服务者在线看板快捷发单',
    child.`parentId` = parent.`id`,
    child.`updatedAt` = NOW()
WHERE child.`key` = 'orders:workbench:create:button';

INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT new_perm.`id`, role_perm.`B`
FROM `Permission` old_perm
JOIN `_PermissionToRole` role_perm ON role_perm.`A` = old_perm.`id`
JOIN `Permission` new_perm ON new_perm.`key` = 'service:online-board:page'
WHERE old_perm.`key` = 'orders:workbench:page';

INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT p.`id`, r.`id`
FROM `Permission` p
JOIN `Role` r ON r.`name` IN ('SUPER_ADMIN', 'CS_MANAGER')
WHERE p.`key` = 'service:online-board:page';

-- 小程序功能配置：客服二维码配置。
INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`)
SELECT 'miniapp:customer-service:page',
       '客服二维码配置',
       'miniapp',
       'PAGE',
       parent.`id`,
       NOW(),
       NOW()
FROM `Permission` parent
WHERE parent.`key` = 'menu:miniapp-config'
  AND NOT EXISTS (
    SELECT 1
    FROM `Permission` p
    WHERE p.`key` = 'miniapp:customer-service:page'
  );

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'menu:miniapp-config'
SET child.`name` = '客服二维码配置',
    child.`module` = 'miniapp',
    child.`type` = 'PAGE',
    child.`parentId` = parent.`id`,
    child.`updatedAt` = NOW()
WHERE child.`key` = 'miniapp:customer-service:page';

INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT p.`id`, r.`id`
FROM `Permission` p
JOIN `Role` r ON r.`name` = 'SUPER_ADMIN'
WHERE p.`key` = 'miniapp:customer-service:page';

-- 服务者端入口命名收敛。
UPDATE `Permission`
SET `name` = '服务者中心',
    `updatedAt` = NOW()
WHERE `key` = 'menu:staff';

UPDATE `Permission`
SET `name` = '我的服务记录',
    `updatedAt` = NOW()
WHERE `key` = 'staff:my-orders:page';

UPDATE `Permission`
SET `name` = '服务者工作台',
    `updatedAt` = NOW()
WHERE `key` = 'staff:workbench:page';

-- 用户管理下服务者页面命名收敛。
UPDATE `Permission`
SET `name` = '服务者管理',
    `updatedAt` = NOW()
WHERE `key` = 'users:staff:page';

UPDATE `Permission`
SET `name` = '新增服务者',
    `updatedAt` = NOW()
WHERE `key` = 'users:staff:create:button';

UPDATE `Permission`
SET `name` = '编辑服务者资料',
    `updatedAt` = NOW()
WHERE `key` = 'users:staff:edit:button';

UPDATE `Permission`
SET `name` = '服务者分配角色',
    `updatedAt` = NOW()
WHERE `key` = 'users:staff:assign-role:button';

UPDATE `Permission`
SET `name` = '服务者升降级',
    `updatedAt` = NOW()
WHERE `key` = 'users:staff:change-level:button';

UPDATE `Permission`
SET `name` = '重置服务者密码',
    `updatedAt` = NOW()
WHERE `key` = 'users:staff:reset-password:button';

UPDATE `Permission`
SET `name` = '删除服务者',
    `updatedAt` = NOW()
WHERE `key` = 'users:staff:delete:button';

UPDATE `Permission`
SET `name` = '服务者退出平台',
    `updatedAt` = NOW()
WHERE `key` = 'users:staff:exit:button';

UPDATE `Permission`
SET `name` = '服务者清退',
    `updatedAt` = NOW()
WHERE `key` = 'users:staff:clear:button';

UPDATE `Permission`
SET `name` = '服务者资金统计',
    `updatedAt` = NOW()
WHERE `key` = 'users:staff:wallet-stats:button';
