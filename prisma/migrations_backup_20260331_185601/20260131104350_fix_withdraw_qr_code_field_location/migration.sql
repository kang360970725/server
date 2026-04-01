/*
  Warnings:

  - You are about to drop the column `withdrawQrCodeKey` on the `OrderSettlement` table. All the data in the column will be lost.
  - You are about to drop the column `withdrawQrCodeUploadedAt` on the `OrderSettlement` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `OrderSettlement` DROP COLUMN `withdrawQrCodeKey`,
    DROP COLUMN `withdrawQrCodeUploadedAt`;

-- AlterTable
ALTER TABLE `users` ADD COLUMN `withdrawQrCodeKey` VARCHAR(255) NULL,
    ADD COLUMN `withdrawQrCodeUploadedAt` DATETIME(3) NULL;
