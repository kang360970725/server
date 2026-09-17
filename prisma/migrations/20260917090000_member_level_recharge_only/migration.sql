ALTER TABLE `member_profiles`
  ADD COLUMN `manualLevelCode` VARCHAR(32) NULL,
  ADD COLUMN `levelAdjustedAt` DATETIME(3) NULL,
  ADD COLUMN `levelAdjustRemark` VARCHAR(255) NULL;

CREATE UNIQUE INDEX `uniq_member_game_card_category_nickname`
  ON `member_game_cards`(`gameCategoryId`, `gameNickname`);

UPDATE `member_level_configs` SET `minAnnualContribution` = 0;

INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`)
VALUES ('users:member:level-adjust:button', '调整会员等级', 'users', 'BUTTON', (SELECT `id` FROM (SELECT `id` FROM `Permission` WHERE `key`='users:member:page' LIMIT 1) p), NOW(), NOW())
ON DUPLICATE KEY UPDATE `name`=VALUES(`name`), `updatedAt`=NOW();
