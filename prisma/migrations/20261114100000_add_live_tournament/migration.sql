-- CreateTable
CREATE TABLE `LiveTournament` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(120) NOT NULL,
    `gameProjectId` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'PUBLISHED', 'CLOSED') NOT NULL DEFAULT 'DRAFT',
    `salesStartAt` DATETIME(3) NOT NULL,
    `salesEndAt` DATETIME(3) NOT NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NOT NULL,
    `ticketLimit` INTEGER NOT NULL DEFAULT 70,
    `bookingThreshold` INTEGER NOT NULL DEFAULT 40,
    `bookingOpenedAt` DATETIME(3) NULL,
    `leaderboardLockedAt` DATETIME(3) NULL,
    `providerFee` DECIMAL(10, 1) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LiveTournament_gameProjectId_status_idx`(`gameProjectId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LiveTournamentDay` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tournamentId` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NOT NULL,
    `capacity` INTEGER NOT NULL,
    `rosterPublishedAt` DATETIME(3) NULL,

    UNIQUE INDEX `LiveTournamentDay_tournamentId_date_key`(`tournamentId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LiveTournamentQuota` (
    `dayId` INTEGER NOT NULL,
    `providerId` INTEGER NOT NULL,
    `minimum` INTEGER NOT NULL,
    `maximum` INTEGER NOT NULL,

    PRIMARY KEY (`dayId`, `providerId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LiveTournamentEntry` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `tournamentId` INTEGER NOT NULL,
    `orderId` INTEGER NOT NULL,
    `memberId` INTEGER NOT NULL,
    `activeMemberId` INTEGER NULL,
    `dayId` INTEGER NULL,
    `status` ENUM('PENDING_PAYMENT', 'UNBOOKED', 'BOOKED', 'QUEUED', 'ON_STAGE', 'SCORING', 'FINISHED', 'ABSENT', 'VOID') NOT NULL DEFAULT 'PENDING_PAYMENT',
    `contactName` VARCHAR(100) NULL,
    `contactPhone` VARCHAR(32) NULL,
    `gameAccountId` VARCHAR(100) NULL,
    `gameNickname` VARCHAR(100) NULL,
    `gameRank` VARCHAR(100) NULL,
    `competitionName` VARCHAR(100) NULL,
    `queuePosition` INTEGER NULL,
    `checkedInAt` DATETIME(3) NULL,
    `onStageAt` DATETIME(3) NULL,
    `firstRoundStartedAt` DATETIME(3) NULL,
    `usedAt` DATETIME(3) NULL,
    `rescheduledAt` DATETIME(3) NULL,
    `providerId` INTEGER NULL,
    `drawnAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `LiveTournamentEntry_orderId_key`(`orderId`),
    INDEX `LiveTournamentEntry_dayId_status_queuePosition_idx`(`dayId`, `status`, `queuePosition`),
    INDEX `LiveTournamentEntry_tournamentId_memberId_idx`(`tournamentId`, `memberId`),
    UNIQUE INDEX `LiveTournamentEntry_tournamentId_activeMemberId_key`(`tournamentId`, `activeMemberId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LiveTournamentRound` (
    `entryId` INTEGER NOT NULL,
    `roundNumber` INTEGER NOT NULL,
    `kills` INTEGER NULL,
    `firstKillElapsedMs` INTEGER NULL,
    `firstKillAt` DATETIME(3) NULL,
    `forfeited` BOOLEAN NOT NULL DEFAULT false,
    `publishedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`entryId`, `roundNumber`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LiveTournamentDay` ADD CONSTRAINT `LiveTournamentDay_tournamentId_fkey` FOREIGN KEY (`tournamentId`) REFERENCES `LiveTournament`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LiveTournamentQuota` ADD CONSTRAINT `LiveTournamentQuota_dayId_fkey` FOREIGN KEY (`dayId`) REFERENCES `LiveTournamentDay`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LiveTournamentEntry` ADD CONSTRAINT `LiveTournamentEntry_tournamentId_fkey` FOREIGN KEY (`tournamentId`) REFERENCES `LiveTournament`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LiveTournamentEntry` ADD CONSTRAINT `LiveTournamentEntry_dayId_fkey` FOREIGN KEY (`dayId`) REFERENCES `LiveTournamentDay`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LiveTournamentRound` ADD CONSTRAINT `LiveTournamentRound_entryId_fkey` FOREIGN KEY (`entryId`) REFERENCES `LiveTournamentEntry`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
