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
    `status` ENUM('WAIT_ASSIGN', 'WAIT_ACCEPT', 'ACCEPTED', 'ARCHIVED', 'COMPLETED', 'WAIT_REVIEW', 'REVIEWED', 'WAIT_AFTERSALE', 'AFTERSALE_DONE', 'REFUNDED') NOT NULL DEFAULT 'WAIT_ASSIGN',
    `currentDispatchId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Order_autoSerial_key`(`autoSerial`),
    INDEX `Order_projectId_idx`(`projectId`),
    INDEX `Order_dispatcherId_idx`(`dispatcherId`),
    INDEX `Order_status_idx`(`status`),
    INDEX `Order_customerGameId_idx`(`customerGameId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderDispatch` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` INTEGER NOT NULL,
    `round` INTEGER NOT NULL,
    `status` ENUM('WAIT_ASSIGN', 'WAIT_ACCEPT', 'ACCEPTED', 'ARCHIVED', 'COMPLETED') NOT NULL DEFAULT 'WAIT_ASSIGN',
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
    `calculatedEarnings` DOUBLE NOT NULL,
    `manualAdjustment` DOUBLE NOT NULL DEFAULT 0,
    `finalEarnings` DOUBLE NOT NULL,
    `clubEarnings` DOUBLE NULL,
    `csEarnings` DOUBLE NULL,
    `inviteEarnings` DOUBLE NULL,
    `paymentStatus` ENUM('UNPAID', 'PAID') NOT NULL DEFAULT 'UNPAID',
    `paidAt` DATETIME(3) NULL,
    `settledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `adjustedBy` INTEGER NULL,
    `adjustedAt` DATETIME(3) NULL,
    `adjustRemark` VARCHAR(191) NULL,

    INDEX `OrderSettlement_orderId_idx`(`orderId`),
    INDEX `OrderSettlement_dispatchId_idx`(`dispatchId`),
    INDEX `OrderSettlement_userId_idx`(`userId`),
    INDEX `OrderSettlement_paymentStatus_idx`(`paymentStatus`),
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
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `GameProject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_dispatcherId_fkey` FOREIGN KEY (`dispatcherId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_currentDispatchId_fkey` FOREIGN KEY (`currentDispatchId`) REFERENCES `OrderDispatch`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderDispatch` ADD CONSTRAINT `OrderDispatch_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderParticipant` ADD CONSTRAINT `OrderParticipant_dispatchId_fkey` FOREIGN KEY (`dispatchId`) REFERENCES `OrderDispatch`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderParticipant` ADD CONSTRAINT `OrderParticipant_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderSettlement` ADD CONSTRAINT `OrderSettlement_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderSettlement` ADD CONSTRAINT `OrderSettlement_dispatchId_fkey` FOREIGN KEY (`dispatchId`) REFERENCES `OrderDispatch`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderSettlement` ADD CONSTRAINT `OrderSettlement_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SettlementBatch` ADD CONSTRAINT `SettlementBatch_createdBy_fkey` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
