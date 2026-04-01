/*
  Warnings:

  - You are about to alter the column `settlementBatchId` on the `OrderSettlement` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `VarChar(36)`.

*/
-- AlterTable
ALTER TABLE `OrderSettlement` MODIFY `settlementBatchId` VARCHAR(36) NOT NULL;
