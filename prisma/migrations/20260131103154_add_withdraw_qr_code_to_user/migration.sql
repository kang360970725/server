-- AlterTable
ALTER TABLE `OrderSettlement` ADD COLUMN `withdrawQrCodeKey` VARCHAR(255) NULL,
    ADD COLUMN `withdrawQrCodeUploadedAt` DATETIME(3) NULL;
