-- 拆分 SUPER_ADMIN 与 FINANCE_ADMIN 的历史语义混用：
-- 1. SUPER_ADMIN 是唯一超级管理员角色；
-- 2. FINANCE_ADMIN 重命名为 FINANCE_MANAGER，仅作为财务管理员角色；
-- 3. 用户身份为 SUPER_ADMIN 的账号自动绑定 SUPER_ADMIN 角色。

INSERT INTO `Role` (`name`, `description`, `createdAt`, `updatedAt`)
SELECT 'SUPER_ADMIN', '超级管理员', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM `Role` WHERE `name` = 'SUPER_ADMIN');

INSERT INTO `Role` (`name`, `description`, `createdAt`, `updatedAt`)
SELECT 'FINANCE_MANAGER', '财务管理员', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM `Role` WHERE `name` = 'FINANCE_MANAGER');

UPDATE `Role`
SET `description` = '超级管理员',
    `updatedAt` = NOW()
WHERE `name` = 'SUPER_ADMIN';

UPDATE `Role`
SET `description` = '财务管理员',
    `updatedAt` = NOW()
WHERE `name` = 'FINANCE_MANAGER';

UPDATE `users` u
JOIN `Role` sr ON sr.`name` = 'SUPER_ADMIN'
SET u.`roleId` = sr.`id`
WHERE u.`userType` = 'SUPER_ADMIN';

UPDATE `users` u
JOIN `Role` oldr ON oldr.`name` = 'FINANCE_ADMIN' AND u.`roleId` = oldr.`id`
JOIN `Role` fr ON fr.`name` = 'FINANCE_MANAGER'
SET u.`roleId` = fr.`id`
WHERE u.`userType` <> 'SUPER_ADMIN';

DELETE ptr
FROM `_PermissionToRole` ptr
JOIN `Role` r ON r.`id` = ptr.`B`
WHERE r.`name` IN ('SUPER_ADMIN', 'FINANCE_MANAGER');

INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT p.`id`, r.`id`
FROM `Permission` p
JOIN `Role` r ON r.`name` = 'SUPER_ADMIN'
WHERE p.`key` NOT LIKE 'menu:%';

INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT p.`id`, r.`id`
FROM `Permission` p
JOIN `Role` r ON r.`name` = 'FINANCE_MANAGER'
WHERE p.`key` IN (
  'finance:dashboard:view',
  'finance:records:list',
  'finance:offline-fees:page',
  'finance:equipment-rental-fees:page',
  'wallet:overview:page',
  'wallet:member-levels:page',
  'wallet:recharge-plans:page',
  'wallet:transactions:page',
  'wallet:replay-preview:page',
  'wallet:withdrawals:page',
  'orders:list:page',
  'orders:detail:page',
  'orders:detail:receipt:button',
  'orders:detail:mark-paid:button',
  'orders:detail:update-paid:button'
);

DELETE ptr
FROM `_PermissionToRole` ptr
JOIN `Role` r ON r.`id` = ptr.`B`
WHERE r.`name` = 'FINANCE_ADMIN';

DELETE FROM `Role`
WHERE `name` = 'FINANCE_ADMIN';
