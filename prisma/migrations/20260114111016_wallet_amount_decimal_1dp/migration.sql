-- AlterTable
ALTER TABLE `OrderSettlement` MODIFY `calculatedEarnings` DECIMAL(10, 1) NULL,
    MODIFY `manualAdjustment` DECIMAL(10, 1) NULL,
    MODIFY `finalEarnings` DECIMAL(10, 1) NULL,
    MODIFY `clubEarnings` DECIMAL(10, 1) NULL;

-- AlterTable
ALTER TABLE `wallet_accounts` MODIFY `availableBalance` DECIMAL(10, 1) NOT NULL DEFAULT 0,
    MODIFY `frozenBalance` DECIMAL(10, 1) NOT NULL DEFAULT 0;
