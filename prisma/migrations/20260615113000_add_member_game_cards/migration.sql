CREATE TABLE `member_game_cards` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `gameCategoryId` VARCHAR(64) NOT NULL,
  `gameCategoryName` VARCHAR(120) NOT NULL,
  `gameUniqueId` VARCHAR(64) NOT NULL,
  `gameNickname` VARCHAR(64) NULL,
  `isPrimary` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uniq_member_game_card_category_unique_id`(`gameCategoryId`, `gameUniqueId`),
  INDEX `idx_member_game_card_user_category`(`userId`, `gameCategoryId`),
  INDEX `idx_member_game_card_user_primary`(`userId`, `isPrimary`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `member_game_cards`
  ADD CONSTRAINT `member_game_cards_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`)
  ON DELETE CASCADE
  ON UPDATE CASCADE;
