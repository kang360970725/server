ALTER TABLE `wallet_accounts`
  ADD COLUMN `memberOrderReservedBalance` DECIMAL(12, 2) NOT NULL DEFAULT 0.00;

ALTER TABLE `Order`
  ADD COLUMN `balanceSettlementMode` VARCHAR(32) NULL,
  ADD COLUMN `balanceReservationStatus` VARCHAR(24) NULL,
  ADD COLUMN `balanceReservedAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `balanceCapturedAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN `balancePendingSupplementAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00;

CREATE TABLE `member_order_balance_reservations` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `reservationNo` VARCHAR(64) NOT NULL,
  `orderId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `reservedAmount` DECIMAL(12, 2) NOT NULL,
  `capturedAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `releasedAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `supplementAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(24) NOT NULL DEFAULT 'HELD',
  `expiresAt` DATETIME(3) NULL,
  `capturedAt` DATETIME(3) NULL,
  `releasedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `member_order_balance_reservations_reservationNo_key` (`reservationNo`),
  UNIQUE INDEX `member_order_balance_reservations_orderId_key` (`orderId`),
  INDEX `idx_member_order_reservation_user_status` (`userId`, `status`, `createdAt`),
  INDEX `idx_member_order_reservation_status_expiry` (`status`, `expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_order_balance_reservation_lots` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `reservationId` INTEGER NOT NULL,
  `lotId` INTEGER NOT NULL,
  `principalReserved` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `bonusReserved` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `principalCaptured` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `bonusCaptured` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uniq_member_order_reservation_lot` (`reservationId`, `lotId`),
  INDEX `idx_member_order_reservation_lot_lot` (`lotId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `member_order_balance_reservations`
  ADD CONSTRAINT `member_order_balance_reservations_orderId_fkey`
    FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `member_order_balance_reservations_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `member_order_balance_reservation_lots`
  ADD CONSTRAINT `member_order_balance_reservation_lots_reservationId_fkey`
    FOREIGN KEY (`reservationId`) REFERENCES `member_order_balance_reservations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `member_order_balance_reservation_lots_lotId_fkey`
    FOREIGN KEY (`lotId`) REFERENCES `member_balance_lots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
