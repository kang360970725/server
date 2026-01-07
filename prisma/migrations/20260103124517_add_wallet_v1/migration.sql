-- AlterTable
ALTER TABLE `Order` ADD COLUMN `isGifted` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `wallet_accounts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `availableBalance` DOUBLE NOT NULL DEFAULT 0,
    `frozenBalance` DOUBLE NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `wallet_accounts_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallet_transactions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `direction` ENUM('IN', 'OUT') NOT NULL,
    `bizType` ENUM('SETTLEMENT_EARNING', 'RELEASE_FROZEN', 'REFUND_REVERSAL') NOT NULL,
    `amount` DOUBLE NOT NULL,
    `status` ENUM('FROZEN', 'AVAILABLE', 'REVERSED') NOT NULL DEFAULT 'FROZEN',
    `sourceType` VARCHAR(191) NOT NULL,
    `sourceId` INTEGER NOT NULL,
    `orderId` INTEGER NULL,
    `dispatchId` INTEGER NULL,
    `settlementId` INTEGER NULL,
    `reversalOfTxId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `wallet_transactions_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `wallet_transactions_orderId_idx`(`orderId`),
    INDEX `wallet_transactions_settlementId_idx`(`settlementId`),
    INDEX `wallet_transactions_status_idx`(`status`),
    UNIQUE INDEX `uniq_wallet_tx_source`(`sourceType`, `sourceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallet_holds` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `earningTxId` INTEGER NOT NULL,
    `amount` DOUBLE NOT NULL,
    `status` ENUM('FROZEN', 'RELEASED', 'CANCELLED') NOT NULL DEFAULT 'FROZEN',
    `unlockAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `releasedAt` DATETIME(3) NULL,

    UNIQUE INDEX `wallet_holds_earningTxId_key`(`earningTxId`),
    INDEX `wallet_holds_status_unlockAt_idx`(`status`, `unlockAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `wallet_accounts` ADD CONSTRAINT `wallet_accounts_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_reversalOfTxId_fkey` FOREIGN KEY (`reversalOfTxId`) REFERENCES `wallet_transactions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_holds` ADD CONSTRAINT `wallet_holds_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_holds` ADD CONSTRAINT `wallet_holds_earningTxId_fkey` FOREIGN KEY (`earningTxId`) REFERENCES `wallet_transactions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
