CREATE TABLE `wallet_anomaly_ignores` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `signature` VARCHAR(191) NOT NULL,
    `currentAvailable` DOUBLE NOT NULL,
    `currentFrozen` DOUBLE NOT NULL,
    `currentTotal` DOUBLE NOT NULL,
    `replayAvailable` DOUBLE NOT NULL,
    `replayFrozen` DOUBLE NOT NULL,
    `replayTotal` DOUBLE NOT NULL,
    `availableGap` DOUBLE NOT NULL,
    `frozenGap` DOUBLE NOT NULL,
    `totalGap` DOUBLE NOT NULL,
    `reason` TEXT NULL,
    `operatorId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uniq_wallet_anomaly_ignore_user_signature`(`userId`, `signature`),
    INDEX `wallet_anomaly_ignores_userId_createdAt_idx`(`userId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `wallet_anomaly_ignores`
    ADD CONSTRAINT `wallet_anomaly_ignores_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
