ALTER TABLE `LiveTournamentEntry`
    DROP INDEX `LiveTournamentEntry_orderId_key`,
    ADD COLUMN `attemptNumber` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `isRevival` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `revivalGrantedAt` DATETIME(3) NULL,
    ADD COLUMN `revivalGrantedBy` INTEGER NULL,
    ADD COLUMN `revivalRevokedAt` DATETIME(3) NULL,
    ADD COLUMN `revivalRevokedBy` INTEGER NULL,
    ADD UNIQUE INDEX `uq_live_tournament_order_attempt`(`orderId`, `attemptNumber`);

CREATE TABLE `LiveTournamentRevivalSettlement` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `entryId` INTEGER NOT NULL,
    `orderId` INTEGER NOT NULL,
    `providerId` INTEGER NOT NULL,
    `amount` DECIMAL(10, 1) NOT NULL,
    `settledBy` INTEGER NOT NULL,
    `settledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `LiveTournamentRevivalSettlement_entryId_key`(`entryId`),
    INDEX `LiveTournamentRevivalSettlement_orderId_idx`(`orderId`),
    INDEX `LiveTournamentRevivalSettlement_providerId_settledAt_idx`(`providerId`, `settledAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `LiveTournamentRevivalSettlement`
    ADD CONSTRAINT `LiveTournamentRevivalSettlement_entryId_fkey`
    FOREIGN KEY (`entryId`) REFERENCES `LiveTournamentEntry`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
