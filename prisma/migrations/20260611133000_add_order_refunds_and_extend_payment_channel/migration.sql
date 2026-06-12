ALTER TABLE `order_payments`
  MODIFY COLUMN `channel` VARCHAR(32) NOT NULL;

UPDATE `order_payments` op
INNER JOIN `Order` o ON o.`id` = op.`orderId`
SET op.`channel` = CASE
  WHEN o.`orderSource` = 'MINIAPP_SELF_SERVICE' AND op.`channel` IN ('WECHAT', 'MINIAPP_WECHAT') THEN 'MINIAPP_WECHAT'
  WHEN o.`orderSource` = 'TUTU_PLATFORM' THEN 'TUTU_PLATFORM'
  WHEN o.`orderSource` IN ('THIRD_PARTY_TRANSFER', 'OFFICIAL_ACCOUNT') THEN 'THIRD_PARTY_CHANNEL'
  WHEN o.`orderSource` = 'CUSTOMER_SERVICE_MANUAL' AND op.`channel` IN ('MANUAL', 'MANUAL_SHOUQIANBA') THEN 'MANUAL_SHOUQIANBA'
  WHEN op.`channel` = 'MANUAL' THEN 'MANUAL_SHOUQIANBA'
  WHEN op.`channel` = 'WECHAT' THEN 'MINIAPP_WECHAT'
  ELSE op.`channel`
END;

CREATE TABLE `order_refunds` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `orderId` INTEGER NOT NULL,
  `paymentId` INTEGER NULL,
  `refundNo` VARCHAR(64) NOT NULL,
  `channel` VARCHAR(32) NOT NULL,
  `status` VARCHAR(24) NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  `currency` VARCHAR(8) NOT NULL DEFAULT 'CNY',
  `reason` VARCHAR(128) NULL,
  `externalRefundId` VARCHAR(128) NULL,
  `operatorId` INTEGER NULL,
  `raw` JSON NULL,
  `refundedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `order_refunds_refundNo_key`(`refundNo`),
  INDEX `idx_order_refunds_order_time`(`orderId`, `createdAt`),
  INDEX `idx_order_refunds_payment`(`paymentId`),
  INDEX `idx_order_refunds_channel_status_time`(`channel`, `status`, `refundedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `order_refunds`
  ADD CONSTRAINT `order_refunds_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `order_refunds`
  ADD CONSTRAINT `order_refunds_paymentId_fkey`
  FOREIGN KEY (`paymentId`) REFERENCES `order_payments`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
