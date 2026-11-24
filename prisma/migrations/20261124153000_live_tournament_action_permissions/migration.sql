INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`) VALUES
('live-tournament:score-entry:button', '录入赛事成绩', 'live-tournament', 'BUTTON', NULL, NOW(), NOW()),
('live-tournament:score-publish:button', '发布赛事成绩/锁榜', 'live-tournament', 'BUTTON', NULL, NOW(), NOW()),
('live-tournament:ticket-settle:button', '赛事门票结算', 'live-tournament', 'BUTTON', NULL, NOW(), NOW())
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`), `module` = VALUES(`module`), `type` = VALUES(`type`), `updatedAt` = NOW();

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'live-tournament:view'
SET child.`parentId` = parent.`id`
WHERE child.`key` IN (
  'live-tournament:score-entry:button',
  'live-tournament:score-publish:button',
  'live-tournament:ticket-settle:button'
);

-- Preserve the capabilities of roles that passed the previous combined check.
INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT target.`id`, tournament_grant.`B`
FROM `_PermissionToRole` tournament_grant
JOIN `Permission` tournament_permission
  ON tournament_permission.`id` = tournament_grant.`A`
  AND tournament_permission.`key` = 'live-tournament:operate'
JOIN `_PermissionToRole` completion_grant
  ON completion_grant.`B` = tournament_grant.`B`
JOIN `Permission` completion_permission
  ON completion_permission.`id` = completion_grant.`A`
  AND completion_permission.`key` = 'orders:detail:confirm-complete:button'
JOIN `Permission` target
  ON target.`key` IN (
    'live-tournament:score-entry:button',
    'live-tournament:score-publish:button',
    'live-tournament:ticket-settle:button'
  );
