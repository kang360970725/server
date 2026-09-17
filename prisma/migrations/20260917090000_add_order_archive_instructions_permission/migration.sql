INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`)
SELECT
  'orders:archive-instructions:page',
  '存单说明维护',
  'orders',
  'PAGE',
  parent.`id`,
  NOW(),
  NOW()
FROM `Permission` parent
WHERE parent.`key` = 'orders:list:page'
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `module` = VALUES(`module`),
  `type` = VALUES(`type`),
  `parentId` = VALUES(`parentId`),
  `updatedAt` = NOW();
