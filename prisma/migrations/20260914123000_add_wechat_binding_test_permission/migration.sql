INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`)
SELECT 'system:wechat-binding-test:page', '微信绑定测试', 'system', 'PAGE', parent.`id`, NOW(), NOW()
FROM `Permission` parent
WHERE parent.`key` = 'menu:system'
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `module` = VALUES(`module`),
  `type` = VALUES(`type`),
  `parentId` = VALUES(`parentId`),
  `updatedAt` = NOW();
