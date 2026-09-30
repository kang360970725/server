ALTER TABLE `product_reviews`
  MODIFY `score` DOUBLE NOT NULL;

ALTER TABLE `order_player_evaluations`
  MODIFY `score` DOUBLE NOT NULL,
  ADD COLUMN `technicalScore` DOUBLE NOT NULL DEFAULT 5,
  ADD COLUMN `serviceScore` DOUBLE NOT NULL DEFAULT 5,
  ADD COLUMN `comprehensiveScore` DOUBLE NOT NULL DEFAULT 5;

ALTER TABLE `staff_public_cards`
  ADD COLUMN `imageUrls` JSON NULL,
  ADD COLUMN `audioUrl` VARCHAR(500) NULL,
  ADD COLUMN `videoUrl` VARCHAR(500) NULL,
  ADD COLUMN `assessmentAt` DATETIME(3) NULL,
  ADD COLUMN `antiCheatImages` JSON NULL,
  ADD COLUMN `resultImages` JSON NULL;
