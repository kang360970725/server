-- CreateTable
CREATE TABLE `GameProject` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `price` DOUBLE NOT NULL,
    `type` ENUM('EXPERIENCE', 'FUN', 'ESCORT', 'LUCKY_BAG', 'BLIND_BOX', 'CUSTOM', 'CUSTOMIZED') NOT NULL,
    `billingMode` ENUM('HOURLY', 'GUARANTEED', 'MODE_PLAY') NOT NULL DEFAULT 'GUARANTEED',
    `baseAmount` DOUBLE NULL,
    `clubRate` DOUBLE NULL,
    `coverImage` VARCHAR(191) NULL,
    `description` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Role` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Role_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Permission` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `module` VARCHAR(191) NOT NULL,
    `type` ENUM('PAGE', 'BUTTON') NOT NULL,
    `parentId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Permission_key_key`(`key`),
    INDEX `Permission_parentId_fkey`(`parentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `phone` VARCHAR(191) NOT NULL,
    `password` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `userType` ENUM('SUPER_ADMIN', 'ADMIN', 'STAFF', 'CUSTOMER_SERVICE', 'OPERATION', 'FINANCE', 'REGISTERED_USER') NOT NULL DEFAULT 'REGISTERED_USER',
    `status` ENUM('ACTIVE', 'FROZEN', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `realName` VARCHAR(191) NULL,
    `idCard` VARCHAR(191) NULL,
    `avatar` VARCHAR(191) NULL,
    `album` JSON NULL,
    `rating` INTEGER NULL,
    `level` INTEGER NOT NULL DEFAULT 1,
    `balance` DOUBLE NOT NULL DEFAULT 0,
    `needResetPwd` BOOLEAN NOT NULL DEFAULT false,
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `roleId` INTEGER NULL,
    `workStatus` ENUM('IDLE', 'WORKING', 'RESTING') NOT NULL DEFAULT 'IDLE',
    `withdrawQrCodeKey` VARCHAR(255) NULL,
    `withdrawQrCodeUploadedAt` DATETIME(3) NULL,
    `canWithdraw` BOOLEAN NOT NULL DEFAULT true,
    `depositLimit` DECIMAL(10, 2) NOT NULL DEFAULT 2000.00,

    UNIQUE INDEX `users_phone_key`(`phone`),
    INDEX `users_workStatus_idx`(`workStatus`),
    INDEX `users_rating_fkey`(`rating`),
    INDEX `users_roleId_fkey`(`roleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_ratings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `rules` VARCHAR(191) NOT NULL,
    `scope` ENUM('ONLINE', 'OFFLINE', 'BOTH') NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `rate` DOUBLE NOT NULL,

    UNIQUE INDEX `staff_ratings_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Recharge` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `amount` DOUBLE NOT NULL,
    `userId` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'COMPLETED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Recharge_userId_fkey`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `targetType` VARCHAR(191) NOT NULL,
    `targetId` INTEGER NULL,
    `oldData` JSON NULL,
    `newData` JSON NULL,
    `remark` VARCHAR(191) NULL,
    `ip` VARCHAR(191) NULL,
    `userAgent` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `user_logs_userId_fkey`(`userId`),
    INDEX `user_logs_target`(`targetType`, `targetId`),
    INDEX `user_logs_action`(`action`),
    INDEX `user_logs_createdAt`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Order` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `autoSerial` VARCHAR(191) NOT NULL,
    `receivableAmount` DOUBLE NOT NULL,
    `paidAmount` DOUBLE NOT NULL,
    `orderTime` DATETIME(3) NULL,
    `paymentTime` DATETIME(3) NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `baseAmountWan` DOUBLE NULL,
    `orderQuantity` INTEGER NOT NULL DEFAULT 1,
    `projectId` INTEGER NOT NULL,
    `projectSnapshot` JSON NOT NULL,
    `customerGameId` VARCHAR(191) NULL,
    `dispatcherId` INTEGER NOT NULL,
    `revisitDetail` VARCHAR(191) NULL,
    `revisitStatus` ENUM('NOT_REVISITED', 'GOOD', 'NEUTRAL', 'BAD', 'COMPLAINT') NOT NULL DEFAULT 'NOT_REVISITED',
    `csRate` DOUBLE NULL,
    `inviteRate` DOUBLE NULL,
    `inviter` VARCHAR(191) NULL,
    `customClubRate` DOUBLE NULL,
    `clubRate` DOUBLE NULL,
    `clubEarnings` DOUBLE NULL,
    `totalPlayerEarnings` DOUBLE NULL,
    `status` ENUM('WAIT_ASSIGN', 'WAIT_ACCEPT', 'ACCEPTED', 'ARCHIVED', 'COMPLETED_PENDING_CONFIRM', 'COMPLETED', 'WAIT_REVIEW', 'REVIEWED', 'WAIT_AFTERSALE', 'AFTERSALE_DONE', 'REFUNDED') NOT NULL DEFAULT 'WAIT_ASSIGN',
    `currentDispatchId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `isGifted` BOOLEAN NOT NULL DEFAULT false,
    `giftedAmount` DECIMAL(10, 2) NULL,
    `isPaid` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `Order_autoSerial_key`(`autoSerial`),
    INDEX `Order_projectId_idx`(`projectId`),
    INDEX `Order_dispatcherId_idx`(`dispatcherId`),
    INDEX `Order_status_idx`(`status`),
    INDEX `Order_customerGameId_idx`(`customerGameId`),
    INDEX `Order_currentDispatchId_fkey`(`currentDispatchId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderDispatch` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` INTEGER NOT NULL,
    `round` INTEGER NOT NULL,
    `status` ENUM('WAIT_ASSIGN', 'WAIT_ACCEPT', 'ACCEPTED', 'SETTLING', 'ARCHIVED', 'COMPLETED') NOT NULL DEFAULT 'WAIT_ASSIGN',
    `assignedAt` DATETIME(3) NULL,
    `acceptedAllAt` DATETIME(3) NULL,
    `archivedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `deductMinutes` ENUM('M10', 'M20', 'M30', 'M40', 'M50', 'M60') NULL,
    `deductMinutesValue` INTEGER NULL,
    `billableMinutes` INTEGER NULL,
    `billableHours` DOUBLE NULL,
    `remark` VARCHAR(191) NULL,

    INDEX `OrderDispatch_orderId_idx`(`orderId`),
    INDEX `OrderDispatch_status_idx`(`status`),
    UNIQUE INDEX `OrderDispatch_orderId_round_key`(`orderId`, `round`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderParticipant` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `dispatchId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `rejectedAt` DATETIME(3) NULL,
    `rejectReason` VARCHAR(191) NULL,
    `contributionAmount` DOUBLE NULL DEFAULT 0,
    `progressBaseWan` DOUBLE NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,

    INDEX `OrderParticipant_dispatchId_idx`(`dispatchId`),
    INDEX `OrderParticipant_userId_idx`(`userId`),
    UNIQUE INDEX `OrderParticipant_dispatchId_userId_key`(`dispatchId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderSettlement` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` INTEGER NOT NULL,
    `dispatchId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `settlementType` VARCHAR(191) NOT NULL,
    `calculatedEarnings` DECIMAL(10, 1) NULL,
    `manualAdjustment` DECIMAL(10, 1) NULL,
    `finalEarnings` DECIMAL(10, 1) NULL,
    `clubEarnings` DECIMAL(10, 1) NULL,
    `csEarnings` DOUBLE NULL,
    `inviteEarnings` DOUBLE NULL,
    `paymentStatus` ENUM('UNPAID', 'PAID') NOT NULL DEFAULT 'UNPAID',
    `paidAt` DATETIME(3) NULL,
    `settledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `adjustedBy` INTEGER NULL,
    `adjustedAt` DATETIME(3) NULL,
    `adjustRemark` VARCHAR(191) NULL,
    `settlementBatchId` VARCHAR(36) NOT NULL,

    INDEX `OrderSettlement_orderId_idx`(`orderId`),
    INDEX `OrderSettlement_dispatchId_idx`(`dispatchId`),
    INDEX `OrderSettlement_userId_idx`(`userId`),
    INDEX `OrderSettlement_paymentStatus_idx`(`paymentStatus`),
    INDEX `OrderSettlement_settlementBatchId_idx`(`settlementBatchId`),
    UNIQUE INDEX `uniq_settlement_dispatch_user_type`(`dispatchId`, `userId`, `settlementType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SettlementBatch` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `batchType` ENUM('EXPERIENCE_3DAY', 'MONTHLY_REGULAR') NOT NULL,
    `periodStart` DATETIME(3) NOT NULL,
    `periodEnd` DATETIME(3) NOT NULL,
    `createdBy` INTEGER NOT NULL,
    `totalIncome` DOUBLE NULL,
    `clubIncome` DOUBLE NULL,
    `payableToPlayers` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SettlementBatch_batchType_idx`(`batchType`),
    INDEX `SettlementBatch_periodStart_periodEnd_idx`(`periodStart`, `periodEnd`),
    INDEX `SettlementBatch_createdBy_fkey`(`createdBy`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallet_accounts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `availableBalance` DECIMAL(10, 1) NOT NULL DEFAULT 0.0,
    `frozenBalance` DECIMAL(10, 1) NOT NULL DEFAULT 0.0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `walletUid` VARCHAR(20) NULL,
    `depositBalance` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,

    UNIQUE INDEX `wallet_accounts_userId_key`(`userId`),
    UNIQUE INDEX `wallet_accounts_walletUid_key`(`walletUid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallet_transactions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `direction` ENUM('IN', 'OUT') NOT NULL,
    `bizType` ENUM('SETTLEMENT_EARNING', 'SETTLEMENT_EARNING_BASE', 'SETTLEMENT_EARNING_CARRY', 'SETTLEMENT_BOMB_LOSS', 'SETTLEMENT_EARNING_CS', 'RELEASE_FROZEN', 'REFUND_REVERSAL', 'WITHDRAW_RESERVE', 'WITHDRAW_RELEASE', 'WITHDRAW_PAYOUT', 'DEPOSIT_REFUND', 'SETTLEMENT_REVERSAL', 'SETTLEMENT_RECALC') NOT NULL,
    `amount` DOUBLE NOT NULL,
    `status` ENUM('FROZEN', 'AVAILABLE', 'REVERSED') NOT NULL DEFAULT 'FROZEN',
    `sourceType` VARCHAR(191) NOT NULL,
    `sourceId` INTEGER NOT NULL,
    `orderId` INTEGER NULL,
    `dispatchId` INTEGER NULL,
    `settlementId` INTEGER NULL,
    `reversalOfTxId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `availableAfter` DECIMAL(18, 2) NULL,
    `frozenAfter` DECIMAL(18, 2) NULL,

    INDEX `wallet_transactions_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `wallet_transactions_orderId_idx`(`orderId`),
    INDEX `wallet_transactions_settlementId_idx`(`settlementId`),
    INDEX `wallet_transactions_status_idx`(`status`),
    INDEX `wallet_transactions_reversalOfTxId_fkey`(`reversalOfTxId`),
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
    INDEX `wallet_holds_userId_fkey`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallet_withdrawal_requests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `amount` DOUBLE NOT NULL,
    `status` ENUM('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAYING', 'PAID', 'FAILED', 'CANCELED') NOT NULL DEFAULT 'PENDING_REVIEW',
    `channel` ENUM('WECHAT', 'MANUAL') NOT NULL DEFAULT 'MANUAL',
    `idempotencyKey` VARCHAR(64) NOT NULL,
    `requestNo` VARCHAR(32) NOT NULL,
    `remark` VARCHAR(191) NULL,
    `reviewedBy` INTEGER NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewRemark` VARCHAR(191) NULL,
    `reserveTxId` INTEGER NOT NULL,
    `payoutTxId` INTEGER NULL,
    `outTradeNo` VARCHAR(64) NULL,
    `channelTradeNo` VARCHAR(64) NULL,
    `callbackRaw` TEXT NULL,
    `failReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `wallet_withdrawal_requests_requestNo_key`(`requestNo`),
    UNIQUE INDEX `wallet_withdrawal_requests_reserveTxId_key`(`reserveTxId`),
    UNIQUE INDEX `wallet_withdrawal_requests_payoutTxId_key`(`payoutTxId`),
    INDEX `wallet_withdrawal_requests_userId_status_createdAt_idx`(`userId`, `status`, `createdAt`),
    INDEX `wallet_withdrawal_requests_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `wallet_withdrawal_requests_status_reviewedAt_idx`(`status`, `reviewedAt`),
    UNIQUE INDEX `uniq_withdraw_user_idempotency`(`userId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WalletDepositTransaction` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `bizType` ENUM('WITHDRAW_PERCENT', 'REWARD_TRANSFER', 'MANUAL_DEPOSIT', 'PENALTY_DEDUCT', 'DEPOSIT_REFUND') NOT NULL,
    `remark` VARCHAR(255) NULL,
    `operatorId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `WalletDepositTransaction_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `_PermissionToRole` (
    `A` INTEGER NOT NULL,
    `B` INTEGER NOT NULL,

    UNIQUE INDEX `_PermissionToRole_AB_unique`(`A`, `B`),
    INDEX `_PermissionToRole_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Permission` ADD CONSTRAINT `Permission_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `Permission`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_rating_fkey` FOREIGN KEY (`rating`) REFERENCES `staff_ratings`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_roleId_fkey` FOREIGN KEY (`roleId`) REFERENCES `Role`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Recharge` ADD CONSTRAINT `Recharge_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_logs` ADD CONSTRAINT `user_logs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_currentDispatchId_fkey` FOREIGN KEY (`currentDispatchId`) REFERENCES `OrderDispatch`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_dispatcherId_fkey` FOREIGN KEY (`dispatcherId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `GameProject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderDispatch` ADD CONSTRAINT `OrderDispatch_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderParticipant` ADD CONSTRAINT `OrderParticipant_dispatchId_fkey` FOREIGN KEY (`dispatchId`) REFERENCES `OrderDispatch`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderParticipant` ADD CONSTRAINT `OrderParticipant_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderSettlement` ADD CONSTRAINT `OrderSettlement_dispatchId_fkey` FOREIGN KEY (`dispatchId`) REFERENCES `OrderDispatch`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderSettlement` ADD CONSTRAINT `OrderSettlement_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderSettlement` ADD CONSTRAINT `OrderSettlement_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SettlementBatch` ADD CONSTRAINT `SettlementBatch_createdBy_fkey` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_accounts` ADD CONSTRAINT `wallet_accounts_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_reversalOfTxId_fkey` FOREIGN KEY (`reversalOfTxId`) REFERENCES `wallet_transactions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_transactions` ADD CONSTRAINT `wallet_transactions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_holds` ADD CONSTRAINT `wallet_holds_earningTxId_fkey` FOREIGN KEY (`earningTxId`) REFERENCES `wallet_transactions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_holds` ADD CONSTRAINT `wallet_holds_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_withdrawal_requests` ADD CONSTRAINT `wallet_withdrawal_requests_payoutTxId_fkey` FOREIGN KEY (`payoutTxId`) REFERENCES `wallet_transactions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_withdrawal_requests` ADD CONSTRAINT `wallet_withdrawal_requests_reserveTxId_fkey` FOREIGN KEY (`reserveTxId`) REFERENCES `wallet_transactions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_withdrawal_requests` ADD CONSTRAINT `wallet_withdrawal_requests_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WalletDepositTransaction` ADD CONSTRAINT `WalletDepositTransaction_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_PermissionToRole` ADD CONSTRAINT `_PermissionToRole_A_fkey` FOREIGN KEY (`A`) REFERENCES `Permission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_PermissionToRole` ADD CONSTRAINT `_PermissionToRole_B_fkey` FOREIGN KEY (`B`) REFERENCES `Role`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

