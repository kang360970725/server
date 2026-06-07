-- AlterTable
ALTER TABLE `wallet_transactions` ADD COLUMN `availableAfter` DECIMAL(18, 2) NULL,
    ADD COLUMN `frozenAfter` DECIMAL(18, 2) NULL;
