CREATE TABLE `mini_search_keyword_stats` (
  `id` INTEGER NOT NULL AUTO_INCREMENT, `keyword` VARCHAR(64) NOT NULL, `displayKeyword` VARCHAR(64) NOT NULL,
  `searchCount` INTEGER NOT NULL DEFAULT 0, `resultCount` INTEGER NOT NULL DEFAULT 0,
  `lastSearchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `mini_search_keyword_stats_keyword_key`(`keyword`), INDEX `idx_mini_search_hot`(`lastSearchedAt`,`searchCount`), PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
