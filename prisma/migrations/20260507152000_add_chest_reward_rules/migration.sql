ALTER TABLE `chest_activity_configs`
  ADD COLUMN `launchAt` DATETIME(3) NULL;

ALTER TABLE `chest_reward_items`
  ADD COLUMN `minDrawCount` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `blockBeforeDays` INTEGER NULL,
  ADD COLUMN `blockWhenDrawBelow` INTEGER NULL,
  ADD COLUMN `dynamicMode` VARCHAR(64) NULL,
  ADD COLUMN `publicRuleText` VARCHAR(255) NULL;
