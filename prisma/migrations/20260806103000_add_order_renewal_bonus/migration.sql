ALTER TABLE `Order`
  ADD COLUMN `isRenewal` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `renewalAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `renewalCount` DECIMAL(8, 2) NOT NULL DEFAULT 0;

CREATE INDEX `Order_isRenewal_idx` ON `Order`(`isRenewal`);

CREATE TABLE `order_renewal_groups` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `orderId` INTEGER NOT NULL,
  `dispatchId` INTEGER NOT NULL,
  `groupKey` VARCHAR(255) NOT NULL,
  `memberUserIds` JSON NOT NULL,
  `memberNamesSnapshot` JSON NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  `renewalOrderCount` DECIMAL(8, 2) NOT NULL DEFAULT 0,
  `renewalAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `bonusBaseAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `bonusRate` DECIMAL(6, 4) NOT NULL DEFAULT 0,
  `bonusTotalAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `settlementBatchId` VARCHAR(36) NULL,
  `createdBy` INTEGER NULL,
  `settledBy` INTEGER NULL,
  `settledAt` DATETIME(3) NULL,
  `invalidatedBy` INTEGER NULL,
  `invalidatedAt` DATETIME(3) NULL,
  `invalidateReason` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uniq_order_renewal_group_order`(`orderId`),
  INDEX `idx_order_renewal_group_rank`(`groupKey`, `status`, `settledAt`),
  INDEX `idx_order_renewal_group_dispatch`(`dispatchId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `order_renewal_bonuses` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `orderId` INTEGER NOT NULL,
  `renewalGroupId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `bonusBaseAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `bonusRate` DECIMAL(6, 4) NOT NULL DEFAULT 0,
  `bonusTotalAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `bonusShareAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `status` VARCHAR(24) NOT NULL DEFAULT 'PAID',
  `settlementBatchId` VARCHAR(36) NULL,
  `walletTransactionId` INTEGER NULL,
  `reversalWalletTransactionId` INTEGER NULL,
  `reversalReason` VARCHAR(255) NULL,
  `reversedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uniq_order_renewal_bonus_group_user`(`renewalGroupId`, `userId`),
  INDEX `idx_order_renewal_bonus_order`(`orderId`),
  INDEX `idx_order_renewal_bonus_user_time`(`userId`, `createdAt`),
  INDEX `idx_order_renewal_bonus_status`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `order_renewal_groups`
  ADD CONSTRAINT `order_renewal_groups_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `order_renewal_groups_dispatchId_fkey`
  FOREIGN KEY (`dispatchId`) REFERENCES `OrderDispatch`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `order_renewal_bonuses`
  ADD CONSTRAINT `order_renewal_bonuses_orderId_fkey`
  FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `order_renewal_bonuses_renewalGroupId_fkey`
  FOREIGN KEY (`renewalGroupId`) REFERENCES `order_renewal_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `order_renewal_bonuses_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `wallet_transactions` MODIFY `bizType` ENUM('SETTLEMENT_EARNING', 'SETTLEMENT_EARNING_BASE', 'SETTLEMENT_EARNING_CARRY', 'SETTLEMENT_BOMB_LOSS', 'SETTLEMENT_EARNING_CS', 'ORDER_RENEWAL_BONUS', 'ORDER_RENEWAL_BONUS_REVERSAL', 'RELEASE_FROZEN', 'REFUND_REVERSAL', 'WITHDRAW_RESERVE', 'WITHDRAW_RELEASE', 'WITHDRAW_PAYOUT', 'DEPOSIT_REFUND', 'DEPOSIT_ADD', 'DEPOSIT_DEDUCT', 'OFFLINE_FEE_PAYMENT', 'EQUIPMENT_RENTAL_FEE', 'SETTLEMENT_REVERSAL', 'SETTLEMENT_RECALC', 'MEMBER_RECHARGE', 'MEMBER_RECHARGE_BONUS', 'MEMBER_ORDER_CONSUME', 'MEMBER_RECHARGE_REFUND', 'STAFF_EXIT_RELEASE', 'STAFF_EXIT_CLEAR') NOT NULL;

INSERT INTO `system_configs` (`key`, `value`, `valueType`, `remark`, `enabled`, `createdAt`, `updatedAt`)
VALUES (
  'order_renewal_bonus_rules',
  '{"enabled":true,"baseAmountField":"paidAmount","tiers":[{"min":0,"max":300,"rate":0.01},{"min":300.01,"max":null,"rate":0.02}]}',
  'JSON',
  '续单额外分红配置；配置失效时兜底为实付<=300按1%，>300按2%',
  true,
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
)
ON DUPLICATE KEY UPDATE `updatedAt` = `updatedAt`;
