-- CreateTable
CREATE TABLE `chest_promo_bundles` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `promoCode` VARCHAR(64) NOT NULL,
  `promoType` VARCHAR(32) NOT NULL DEFAULT 'CHEST_PROMO',
  `codeCount` INTEGER NOT NULL,
  `totalKeys` INTEGER NOT NULL,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `expireAt` DATETIME(3) NOT NULL,
  `createdBy` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `chest_promo_bundles_promoCode_key`(`promoCode`),
  INDEX `idx_chest_promo_bundle_type_status`(`promoType`, `active`, `expireAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chest_promo_bundle_items` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `bundleId` INTEGER NOT NULL,
  `redeemCodeId` INTEGER NOT NULL,
  `redeemCode` VARCHAR(64) NOT NULL,
  `keyCount` INTEGER NOT NULL DEFAULT 1,
  `assignedUserId` INTEGER NULL,
  `assignedDeviceId` VARCHAR(128) NULL,
  `assignedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `idx_chest_promo_item_bundle_assigned`(`bundleId`, `assignedAt`),
  INDEX `idx_chest_promo_item_user_day`(`assignedUserId`, `assignedAt`),
  INDEX `idx_chest_promo_item_device_day`(`assignedDeviceId`, `assignedAt`),
  INDEX `idx_chest_promo_item_redeem_code`(`redeemCode`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `chest_promo_bundle_items`
  ADD CONSTRAINT `chest_promo_bundle_items_bundleId_fkey`
  FOREIGN KEY (`bundleId`) REFERENCES `chest_promo_bundles`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chest_promo_bundle_items`
  ADD CONSTRAINT `chest_promo_bundle_items_redeemCodeId_fkey`
  FOREIGN KEY (`redeemCodeId`) REFERENCES `chest_redeem_codes`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chest_promo_bundle_items`
  ADD CONSTRAINT `chest_promo_bundle_items_assignedUserId_fkey`
  FOREIGN KEY (`assignedUserId`) REFERENCES `users`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
