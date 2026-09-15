CREATE TABLE `staff_public_cards` (
  `id` INTEGER NOT NULL AUTO_INCREMENT, `userId` INTEGER NOT NULL, `displayName` VARCHAR(64) NOT NULL,
  `avatarUrl` VARCHAR(500) NULL, `slogan` VARCHAR(120) NULL, `bio` TEXT NULL, `gameTags` JSON NULL,
  `skillTags` JSON NULL, `serviceYears` INTEGER NOT NULL DEFAULT 0, `status` VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  `reviewRemark` VARCHAR(255) NULL, `submittedAt` DATETIME(3) NULL, `reviewedAt` DATETIME(3) NULL,
  `reviewedBy` INTEGER NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `staff_public_cards_userId_key`(`userId`), INDEX `idx_staff_public_card_review`(`status`, `submittedAt`),
  PRIMARY KEY (`id`), CONSTRAINT `staff_public_cards_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `system_configs` (`key`, `value`, `valueType`, `remark`, `enabled`, `createdAt`, `updatedAt`)
VALUES ('mini_member_signin_points', '1', 'NUMBER', '小程序会员每日签到赠送积分；积分具有消费价值，请谨慎调整', true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE `updatedAt` = `updatedAt`;
