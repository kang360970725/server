-- 补齐订单支付状态、支付流水、商品评价，以及订单取消状态

ALTER TABLE `orders`
  MODIFY COLUMN `status` ENUM(
    'WAIT_ASSIGN',
    'WAIT_ACCEPT',
    'ACCEPTED',
    'ARCHIVED',
    'CANCELLED',
    'COMPLETED_PENDING_CONFIRM',
    'COMPLETED',
    'WAIT_REVIEW',
    'REVIEWED',
    'WAIT_AFTERSALE',
    'AFTERSALE_DONE',
    'REFUNDED'
  ) NOT NULL DEFAULT 'WAIT_ASSIGN',
  ADD COLUMN `payStatus` ENUM('PENDING', 'SUCCESS', 'FAILED', 'CLOSED') NOT NULL DEFAULT 'PENDING' AFTER `isPaid`;

CREATE TABLE `order_payments` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `orderId` INTEGER NOT NULL,
  `paymentNo` VARCHAR(64) NOT NULL,
  `channel` VARCHAR(20) NOT NULL,
  `status` ENUM('PENDING', 'SUCCESS', 'FAILED', 'CLOSED') NOT NULL DEFAULT 'PENDING',
  `amount` DECIMAL(10, 2) NOT NULL,
  `currency` VARCHAR(8) NOT NULL DEFAULT 'CNY',
  `prepayId` VARCHAR(128) NULL,
  `transactionId` VARCHAR(128) NULL,
  `payerOpenid` VARCHAR(64) NULL,
  `notifyRaw` JSON NULL,
  `paidAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `order_payments_paymentNo_key`(`paymentNo`),
  INDEX `idx_order_payment_order_status_time`(`orderId`, `status`, `createdAt`),
  INDEX `idx_order_payment_txn`(`transactionId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `order_payments`
  ADD CONSTRAINT `order_payments_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `orders`
  ADD COLUMN `latestPaymentId` INTEGER NULL AFTER `payStatus`,
  ADD INDEX `Order_latestPaymentId_fkey`(`latestPaymentId`);

ALTER TABLE `orders`
  ADD CONSTRAINT `Order_latestPaymentId_fkey`
  FOREIGN KEY (`latestPaymentId`) REFERENCES `order_payments`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `product_reviews` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `projectId` INTEGER NOT NULL,
  `orderId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `score` INTEGER NOT NULL,
  `tags` JSON NULL,
  `content` TEXT NULL,
  `anonymous` BOOLEAN NOT NULL DEFAULT false,
  `isHidden` BOOLEAN NOT NULL DEFAULT false,
  `hiddenReason` VARCHAR(255) NULL,
  `hiddenBy` INTEGER NULL,
  `hiddenAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `product_reviews_orderId_key`(`orderId`),
  INDEX `idx_product_review_project_visible`(`projectId`, `isHidden`, `createdAt`),
  INDEX `idx_product_review_user_created`(`userId`, `createdAt`),
  INDEX `idx_product_review_order`(`orderId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `product_reviews`
  ADD CONSTRAINT `product_reviews_projectId_fkey`
  FOREIGN KEY (`projectId`) REFERENCES `GameProject`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `product_reviews`
  ADD CONSTRAINT `product_reviews_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `product_reviews`
  ADD CONSTRAINT `product_reviews_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
