INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`) VALUES
('live-tournament:view', '赛事管理（查看）', 'live-tournament', 'PAGE', NULL, NOW(), NOW()),
('live-tournament:operate', '赛事运营（含主播工作台）', 'live-tournament', 'BUTTON', NULL, NOW(), NOW())
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`), `module` = VALUES(`module`), `type` = VALUES(`type`), `updatedAt` = NOW();

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'menu:ops'
SET child.`parentId` = parent.`id`
WHERE child.`key` = 'live-tournament:view';

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'live-tournament:view'
SET child.`parentId` = parent.`id`
WHERE child.`key` = 'live-tournament:operate';

-- Preserve existing access for roles that previously operated tournaments through dispatch.
INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT target.`id`, grants.`B`
FROM `_PermissionToRole` grants
JOIN `Permission` legacy ON legacy.`id` = grants.`A` AND legacy.`key` = 'orders:detail:dispatch:button'
JOIN `Permission` target ON target.`key` IN ('live-tournament:view', 'live-tournament:operate');
