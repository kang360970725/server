-- 保证金对账页面权限。

INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`)
SELECT 'wallet:deposit-reconciliation:page',
       '保证金对账',
       'wallet',
       'PAGE',
       parent.`id`,
       NOW(),
       NOW()
FROM `Permission` parent
WHERE parent.`key` = 'menu:wallet'
  AND NOT EXISTS (
    SELECT 1
    FROM `Permission` p
    WHERE p.`key` = 'wallet:deposit-reconciliation:page'
  );

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'menu:wallet'
SET child.`name` = '保证金对账',
    child.`module` = 'wallet',
    child.`type` = 'PAGE',
    child.`parentId` = parent.`id`,
    child.`updatedAt` = NOW()
WHERE child.`key` = 'wallet:deposit-reconciliation:page';

INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT p.`id`, r.`id`
FROM `Permission` p
JOIN `Role` r ON r.`name` = 'SUPER_ADMIN'
WHERE p.`key` = 'wallet:deposit-reconciliation:page';

INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT p.`id`, r.`id`
FROM `Permission` p
JOIN `Role` r ON r.`name` = 'FINANCE_MANAGER'
WHERE p.`key` = 'wallet:deposit-reconciliation:page';
