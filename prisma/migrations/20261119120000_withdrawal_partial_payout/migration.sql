ALTER TABLE `wallet_withdrawal_requests`
    ADD COLUMN `partialPaidAmount` DECIMAL(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN `reserveOffsetAmount` DECIMAL(12,2) NOT NULL DEFAULT 0,
    ADD COLUMN `reserveDispatchIds` JSON NULL;
