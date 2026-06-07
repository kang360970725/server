/*
  Warnings:

  - A unique constraint covering the columns `[walletUid]` on the table `wallet_accounts` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `wallet_accounts` ADD COLUMN `walletUid` VARCHAR(20) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `wallet_accounts_walletUid_key` ON `wallet_accounts`(`walletUid`);
