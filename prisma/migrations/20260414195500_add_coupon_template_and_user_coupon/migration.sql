-- 优惠券体系：模板 + 用户券

CREATE TABLE `coupon_templates` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `type` ENUM('CASH', 'DISCOUNT', 'FULL_REDUCTION', 'FREE') NOT NULL,
  `discountValue` DECIMAL(10, 2) NULL,
  `thresholdAmount` DECIMAL(10, 2) NULL,
  `maxDiscountAmount` DECIMAL(10, 2) NULL,
  `applicableScope` ENUM('ALL', 'PROJECT', 'CATEGORY', 'USER_LEVEL') NOT NULL DEFAULT 'ALL',
  `applicableProjectIds` JSON NULL,
  `status` ENUM('DRAFT', 'ACTIVE', 'DISABLED', 'EXPIRED') NOT NULL DEFAULT 'DRAFT',
  `startAt` DATETIME(3) NULL,
  `endAt` DATETIME(3) NULL,
  `totalLimit` INTEGER NULL,
  `perUserLimit` INTEGER NULL,
  `issuedCount` INTEGER NOT NULL DEFAULT 0,
  `usedCount` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `idx_coupon_template_status_time`(`status`, `startAt`, `endAt`),
  INDEX `idx_coupon_template_scope`(`applicableScope`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `user_coupons` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `templateId` INTEGER NOT NULL,
  `status` ENUM('UNUSED', 'USED', 'EXPIRED', 'LOCKED') NOT NULL DEFAULT 'UNUSED',
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `usedAt` DATETIME(3) NULL,
  `expiresAt` DATETIME(3) NULL,
  `orderId` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `idx_user_coupon_user_status_expire`(`userId`, `status`, `expiresAt`),
  INDEX `idx_user_coupon_template_status`(`templateId`, `status`),
  INDEX `idx_user_coupon_order`(`orderId`),
  UNIQUE INDEX `uniq_user_coupon_order`(`orderId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `user_coupons`
  ADD CONSTRAINT `user_coupons_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `user_coupons`
  ADD CONSTRAINT `user_coupons_templateId_fkey`
  FOREIGN KEY (`templateId`) REFERENCES `coupon_templates`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `user_coupons`
  ADD CONSTRAINT `user_coupons_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
