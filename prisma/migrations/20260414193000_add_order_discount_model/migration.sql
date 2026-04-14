-- 统一订单优惠模型：订单汇总字段 + 优惠明细表

ALTER TABLE `Order`
  ADD COLUMN `originalAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `discountAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `couponDiscountAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `activityDiscountAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `giftDiscountAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `manualAdjustAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `finalPayableAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `marketingCostAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `discountType` VARCHAR(20) NULL;

CREATE TABLE `order_discounts` (
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

ALTER TABLE `order_discounts`
  ADD CONSTRAINT `order_discounts_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
