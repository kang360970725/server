INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`)
SELECT 'users:excellent-staff:page', '优秀服务者管理', 'users', 'PAGE', p.`id`, NOW(3), NOW(3)
FROM `Permission` p
WHERE p.`key` = 'menu:users'
  AND NOT EXISTS (SELECT 1 FROM `Permission` x WHERE x.`key` = 'users:excellent-staff:page');

INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`)
SELECT 'users:excellent-staff:manage:button', '维护优秀服务者', 'users', 'BUTTON', p.`id`, NOW(3), NOW(3)
FROM `Permission` p
WHERE p.`key` = 'users:excellent-staff:page'
  AND NOT EXISTS (SELECT 1 FROM `Permission` x WHERE x.`key` = 'users:excellent-staff:manage:button');
