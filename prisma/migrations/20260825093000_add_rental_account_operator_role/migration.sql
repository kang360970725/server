INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`)
SELECT 'users:staff-rental-risk:page',
       '租号风控查询',
       'users',
       'PAGE',
       parent.`id`,
       NOW(),
       NOW()
FROM `Permission` parent
WHERE parent.`key` = 'menu:users'
  AND NOT EXISTS (
    SELECT 1 FROM `Permission` p WHERE p.`key` = 'users:staff-rental-risk:page'
  );

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'menu:users'
SET child.`parentId` = parent.`id`,
    child.`name` = '租号风控查询',
    child.`module` = 'users',
    child.`type` = 'PAGE',
    child.`updatedAt` = NOW()
WHERE child.`key` = 'users:staff-rental-risk:page';

INSERT INTO `Role` (`name`, `description`, `createdAt`, `updatedAt`)
SELECT 'RENTAL_ACCOUNT_OPERATOR',
       '商行租号专员（仅可查询服务者租号风控余额）',
       NOW(),
       NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM `Role` r WHERE r.`name` = 'RENTAL_ACCOUNT_OPERATOR'
);

UPDATE `Role`
SET `description` = '商行租号专员（仅可查询服务者租号风控余额）',
    `updatedAt` = NOW()
WHERE `name` = 'RENTAL_ACCOUNT_OPERATOR';

INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT p.`id`, r.`id`
FROM `Permission` p
JOIN `Role` r ON r.`name` = 'RENTAL_ACCOUNT_OPERATOR'
WHERE p.`key` = 'users:staff-rental-risk:page';
