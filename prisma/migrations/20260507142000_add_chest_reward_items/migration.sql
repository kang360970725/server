CREATE TABLE `chest_reward_items` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `activityKey` VARCHAR(64) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `type` VARCHAR(32) NOT NULL,
  `quantity` INTEGER NOT NULL DEFAULT 1,
  `weight` INTEGER NOT NULL DEFAULT 1,
  `stock` INTEGER NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 100,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `idx_chest_reward_item_activity_enabled`(`activityKey`, `enabled`),
  INDEX `idx_chest_reward_item_activity_sort`(`activityKey`, `sortOrder`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `chest_reward_items`
  ADD CONSTRAINT `chest_reward_items_activityKey_fkey`
  FOREIGN KEY (`activityKey`) REFERENCES `chest_activity_configs`(`activityKey`)
  ON DELETE CASCADE ON UPDATE CASCADE;
