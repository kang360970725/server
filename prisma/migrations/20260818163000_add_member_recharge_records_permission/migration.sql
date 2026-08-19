INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`)
SELECT 'wallet:member-recharges:page', '会员充值记录', 'wallet', 'PAGE', NULL, NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM `Permission` WHERE `key` = 'wallet:member-recharges:page'
);

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'menu:wallet'
SET child.`parentId` = parent.`id`,
    child.`name` = '会员充值记录',
    child.`module` = 'wallet',
    child.`type` = 'PAGE',
    child.`updatedAt` = NOW()
WHERE child.`key` = 'wallet:member-recharges:page';

INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT p.`id`, r.`id`
FROM `Permission` p
JOIN `Role` r ON r.`name` IN ('SUPER_ADMIN', 'FINANCE_MANAGER')
WHERE p.`key` = 'wallet:member-recharges:page';
