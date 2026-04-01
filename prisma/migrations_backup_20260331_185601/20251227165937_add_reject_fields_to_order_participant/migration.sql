-- AlterTable
ALTER TABLE `OrderParticipant` ADD COLUMN `rejectReason` VARCHAR(191) NULL,
    ADD COLUMN `rejectedAt` DATETIME(3) NULL;
