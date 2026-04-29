-- Hotfix: 补齐订单优惠字段（兼容已漂移数据库）
-- 目标：避免 Prisma 在读取 Order 全字段时因缺列报错（P2022）

SET @db_name = DATABASE();

SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'Order' AND COLUMN_NAME = 'originalAmount'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `Order` ADD COLUMN `originalAmount` DECIMAL(10,2) NOT NULL DEFAULT 0.00', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'Order' AND COLUMN_NAME = 'discountAmount'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `Order` ADD COLUMN `discountAmount` DECIMAL(10,2) NOT NULL DEFAULT 0.00', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'Order' AND COLUMN_NAME = 'couponDiscountAmount'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `Order` ADD COLUMN `couponDiscountAmount` DECIMAL(10,2) NOT NULL DEFAULT 0.00', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'Order' AND COLUMN_NAME = 'activityDiscountAmount'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `Order` ADD COLUMN `activityDiscountAmount` DECIMAL(10,2) NOT NULL DEFAULT 0.00', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'Order' AND COLUMN_NAME = 'giftDiscountAmount'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `Order` ADD COLUMN `giftDiscountAmount` DECIMAL(10,2) NOT NULL DEFAULT 0.00', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'Order' AND COLUMN_NAME = 'manualAdjustAmount'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `Order` ADD COLUMN `manualAdjustAmount` DECIMAL(10,2) NOT NULL DEFAULT 0.00', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'Order' AND COLUMN_NAME = 'finalPayableAmount'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `Order` ADD COLUMN `finalPayableAmount` DECIMAL(10,2) NOT NULL DEFAULT 0.00', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'Order' AND COLUMN_NAME = 'marketingCostAmount'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `Order` ADD COLUMN `marketingCostAmount` DECIMAL(10,2) NOT NULL DEFAULT 0.00', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db_name AND TABLE_NAME = 'Order' AND COLUMN_NAME = 'discountType'
);
SET @sql = IF(@col_exists = 0, 'ALTER TABLE `Order` ADD COLUMN `discountType` VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `order_discounts` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `orderId` INTEGER NOT NULL,
  `sourceType` VARCHAR(20) NOT NULL,
  `sourceId` INTEGER NULL,
  `ruleType` VARCHAR(30) NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  `description` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `idx_order_discounts_order_id`(`orderId`),
  INDEX `idx_order_discounts_source_type`(`sourceType`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @fk_exists = (
  SELECT COUNT(*)
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = @db_name
    AND TABLE_NAME = 'order_discounts'
    AND CONSTRAINT_NAME = 'order_discounts_orderId_fkey'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql = IF(
  @fk_exists = 0,
  'ALTER TABLE `order_discounts` ADD CONSTRAINT `order_discounts_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
