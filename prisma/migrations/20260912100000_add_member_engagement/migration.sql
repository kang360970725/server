CREATE TABLE `member_checkins` (
  `id` INTEGER NOT NULL AUTO_INCREMENT, `userId` INTEGER NOT NULL, `checkinDate` DATE NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `uniq_member_checkin_user_date`(`userId`, `checkinDate`), INDEX `idx_member_checkin_user_time`(`userId`, `createdAt`),
  PRIMARY KEY (`id`), CONSTRAINT `member_checkins_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_project_favorites` (
  `id` INTEGER NOT NULL AUTO_INCREMENT, `userId` INTEGER NOT NULL, `projectId` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `uniq_member_favorite_user_project`(`userId`, `projectId`), INDEX `idx_member_favorite_user_time`(`userId`, `createdAt`),
  PRIMARY KEY (`id`), CONSTRAINT `member_project_favorites_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `member_project_favorites_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `GameProject`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_project_views` (
  `id` INTEGER NOT NULL AUTO_INCREMENT, `userId` INTEGER NOT NULL, `projectId` INTEGER NOT NULL, `viewedOn` DATE NOT NULL,
  `viewCount` INTEGER NOT NULL DEFAULT 1, `lastViewedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uniq_member_view_user_project_day`(`userId`, `projectId`, `viewedOn`), INDEX `idx_member_view_user_time`(`userId`, `lastViewedAt`),
  PRIMARY KEY (`id`), CONSTRAINT `member_project_views_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `member_project_views_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `GameProject`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_achievements` (
  `id` INTEGER NOT NULL AUTO_INCREMENT, `userId` INTEGER NOT NULL, `code` VARCHAR(64) NOT NULL,
  `unlockedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `uniq_member_achievement_user_code`(`userId`, `code`), INDEX `idx_member_achievement_user_time`(`userId`, `unlockedAt`),
  PRIMARY KEY (`id`), CONSTRAINT `member_achievements_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
