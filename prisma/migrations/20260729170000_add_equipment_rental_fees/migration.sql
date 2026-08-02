-- CreateTable
CREATE TABLE `equipment_rental_contracts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `monthlyAmount` DECIMAL(10, 2) NOT NULL,
    `startMonth` VARCHAR(7) NOT NULL,
    `endMonth` VARCHAR(7) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `remark` TEXT NULL,
    `createdBy` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `idx_equipment_rental_contract_user_status`(`userId`, `status`),
    INDEX `idx_equipment_rental_contract_status_month`(`status`, `startMonth`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `equipment_rental_bills` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `contractId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `billMonth` VARCHAR(7) NOT NULL,
    `periodStart` DATETIME(3) NOT NULL,
    `periodEnd` DATETIME(3) NOT NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `paidAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `remainingAmount` DECIMAL(10, 2) NOT NULL,
    `status` ENUM('PENDING', 'PAID', 'WAIVED') NOT NULL DEFAULT 'PENDING',
    `dueAt` DATETIME(3) NULL,
    `confirmedAt` DATETIME(3) NULL,
    `generatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `walletTxId` INTEGER NULL,
    `remark` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uniq_equipment_rental_user_month`(`userId`, `billMonth`),
    UNIQUE INDEX `equipment_rental_bills_walletTxId_key`(`walletTxId`),
    INDEX `idx_equipment_rental_bill_contract_month`(`contractId`, `billMonth`),
    INDEX `idx_equipment_rental_bill_status_month`(`status`, `billMonth`),
    INDEX `idx_equipment_rental_bill_user_status`(`userId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterEnum
ALTER TABLE `wallet_transactions` MODIFY `bizType` ENUM('SETTLEMENT_EARNING', 'SETTLEMENT_EARNING_BASE', 'SETTLEMENT_EARNING_CARRY', 'SETTLEMENT_BOMB_LOSS', 'SETTLEMENT_EARNING_CS', 'RELEASE_FROZEN', 'REFUND_REVERSAL', 'WITHDRAW_RESERVE', 'WITHDRAW_RELEASE', 'WITHDRAW_PAYOUT', 'DEPOSIT_REFUND', 'DEPOSIT_ADD', 'DEPOSIT_DEDUCT', 'OFFLINE_FEE_PAYMENT', 'EQUIPMENT_RENTAL_FEE', 'SETTLEMENT_REVERSAL', 'SETTLEMENT_RECALC', 'MEMBER_RECHARGE', 'MEMBER_RECHARGE_BONUS', 'MEMBER_ORDER_CONSUME', 'MEMBER_RECHARGE_REFUND', 'STAFF_EXIT_RELEASE', 'STAFF_EXIT_CLEAR') NOT NULL;

-- AddForeignKey
ALTER TABLE `equipment_rental_contracts` ADD CONSTRAINT `equipment_rental_contracts_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `equipment_rental_bills` ADD CONSTRAINT `equipment_rental_bills_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `equipment_rental_contracts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `equipment_rental_bills` ADD CONSTRAINT `equipment_rental_bills_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `equipment_rental_bills` ADD CONSTRAINT `equipment_rental_bills_walletTxId_fkey` FOREIGN KEY (`walletTxId`) REFERENCES `wallet_transactions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
