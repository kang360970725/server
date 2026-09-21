ALTER TABLE `staff_leaves`
  ADD COLUMN `rejectedAt` DATETIME(3) NULL,
  ADD COLUMN `rejectedBy` INTEGER NULL,
  ADD COLUMN `rejectReason` VARCHAR(255) NULL;

ALTER TABLE `staff_leaves`
  MODIFY COLUMN `status` ENUM('SCHEDULED', 'ACTIVE', 'COMPLETED', 'EARLY_ENDED', 'CANCELED', 'REJECTED') NOT NULL DEFAULT 'SCHEDULED';

INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`)
SELECT
  'users:staff:leave-reject:button',
  '驳回服务者请假',
  'users',
  'BUTTON',
  parent.`id`,
  NOW(),
  NOW()
FROM `Permission` parent
WHERE parent.`key` = 'users:staff:page'
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `module` = VALUES(`module`),
  `type` = VALUES(`type`),
  `parentId` = VALUES(`parentId`),
  `updatedAt` = NOW();

INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT p.`id`, r.`id`
FROM `Permission` p
JOIN `Role` r ON r.`name` IN ('SUPER_ADMIN', 'CS_MANAGER')
WHERE p.`key` = 'users:staff:leave-reject:button';
