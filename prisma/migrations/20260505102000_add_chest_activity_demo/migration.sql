CREATE TABLE `chest_activity_configs` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `activityKey` VARCHAR(64) NOT NULL,
  `title` VARCHAR(120) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `defaultKeyCount` INTEGER NOT NULL DEFAULT 1,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `chest_activity_configs_activityKey_key`(`activityKey`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chest_redeem_codes` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(64) NOT NULL,
  `keyCount` INTEGER NOT NULL DEFAULT 1,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `expireAt` DATETIME(3) NULL,
  `createdBy` INTEGER NULL,
  `redeemedBy` INTEGER NULL,
  `redeemedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `chest_redeem_codes_code_key`(`code`),
  INDEX `idx_chest_redeem_code_active_expire`(`active`, `expireAt`),
  INDEX `idx_chest_redeem_code_redeemed_by`(`redeemedBy`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chest_user_accounts` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `keyCount` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `chest_user_accounts_userId_key`(`userId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `chest_open_records` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `costKeys` INTEGER NOT NULL DEFAULT 1,
  `rewardJson` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `idx_chest_open_record_user_time`(`userId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `chest_redeem_codes`
  ADD CONSTRAINT `chest_redeem_codes_redeemedBy_fkey`
  FOREIGN KEY (`redeemedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `chest_user_accounts`
  ADD CONSTRAINT `chest_user_accounts_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `chest_open_records`
  ADD CONSTRAINT `chest_open_records_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
