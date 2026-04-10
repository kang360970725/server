-- Add work mode fields to users
ALTER TABLE `users`
  ADD COLUMN `workMode` ENUM('ONLINE', 'OFFLINE') NOT NULL DEFAULT 'ONLINE',
  ADD COLUMN `offlineJoinedAt` DATETIME(3) NULL;

CREATE INDEX `users_workMode_offlineJoinedAt_idx` ON `users`(`workMode`, `offlineJoinedAt`);

-- Add offline fee payment biz type
ALTER TABLE `wallet_transactions`
  MODIFY `bizType` ENUM(
    'SETTLEMENT_EARNING',
    'SETTLEMENT_EARNING_BASE',
    'SETTLEMENT_EARNING_CARRY',
    'SETTLEMENT_BOMB_LOSS',
    'SETTLEMENT_EARNING_CS',
    'RELEASE_FROZEN',
    'REFUND_REVERSAL',
    'WITHDRAW_RESERVE',
    'WITHDRAW_RELEASE',
    'WITHDRAW_PAYOUT',
    'DEPOSIT_REFUND',
    'OFFLINE_FEE_PAYMENT',
    'SETTLEMENT_REVERSAL',
    'SETTLEMENT_RECALC'
  ) NOT NULL;

-- System config table
CREATE TABLE `system_configs` (
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

-- Offline fee bills table
CREATE TABLE `offline_fee_bills` (
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
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `offline_fee_bills`
  ADD CONSTRAINT `offline_fee_bills_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Offline fee payment records
CREATE TABLE `offline_fee_bill_payments` (
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
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `offline_fee_bill_payments`
  ADD CONSTRAINT `offline_fee_bill_payments_billId_fkey`
  FOREIGN KEY (`billId`) REFERENCES `offline_fee_bills`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `offline_fee_bill_payments`
  ADD CONSTRAINT `offline_fee_bill_payments_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
