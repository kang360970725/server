-- Hotfix for production drift:
-- Some environments marked old migrations as applied, but core tables were missing.
-- This migration is idempotent and only ensures required tables exist.

CREATE TABLE IF NOT EXISTS `system_configs` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `key` VARCHAR(64) NOT NULL,
  `value` TEXT NOT NULL,
  `valueType` ENUM('NUMBER', 'STRING', 'BOOLEAN', 'JSON') NOT NULL DEFAULT 'STRING',
  `remark` VARCHAR(255) NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `system_configs_key_key`(`key`),
  INDEX `system_configs_enabled_idx`(`enabled`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `offline_fee_bills` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `billMonth` VARCHAR(7) NOT NULL,
  `periodStart` DATE NOT NULL,
  `periodEnd` DATE NOT NULL,
  `performanceBaseAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `rate` DECIMAL(6, 4) NOT NULL DEFAULT 0.10,
  `minAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `capAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `shouldPayAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `paidAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `remainingAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `status` ENUM('UNPAID', 'PARTIAL', 'PAID', 'WAIVED') NOT NULL DEFAULT 'UNPAID',
  `enforceFullPayment` BOOLEAN NOT NULL DEFAULT false,
  `lastRemindAt` DATETIME(3) NULL,
  `generatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uniq_offline_fee_bill_user_month`(`userId`, `billMonth`),
  INDEX `idx_offline_fee_bill_month_status`(`billMonth`, `status`),
  INDEX `idx_offline_fee_bill_status`(`status`),
  INDEX `idx_offline_fee_bill_enforce`(`enforceFullPayment`),
  PRIMARY KEY (`id`),
  CONSTRAINT `offline_fee_bills_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `offline_fee_bill_payments` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `billId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `amount` DECIMAL(12, 2) NOT NULL,
  `source` ENUM('WITHDRAWAL', 'MANUAL') NOT NULL DEFAULT 'WITHDRAWAL',
  `withdrawalRequestId` INTEGER NULL,
  `operatorId` INTEGER NULL,
  `remark` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `idx_offline_fee_bill_payments_bill`(`billId`, `createdAt`),
  INDEX `idx_offline_fee_bill_payments_user`(`userId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `offline_fee_bill_payments_billId_fkey`
    FOREIGN KEY (`billId`) REFERENCES `offline_fee_bills`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `offline_fee_bill_payments_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
