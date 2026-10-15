ALTER TABLE `order_refunds`
  ADD COLUMN `refundType` VARCHAR(16) NOT NULL DEFAULT 'FULL',
  ADD COLUMN `staffLiable` BOOLEAN NULL,
  ADD COLUMN `liableUserIds` JSON NULL,
  ADD COLUMN `remainingAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00;

CREATE INDEX `idx_order_refunds_type_time`
  ON `order_refunds`(`refundType`, `createdAt`);
