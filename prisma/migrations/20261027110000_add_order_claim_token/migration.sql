ALTER TABLE `Order`
    ADD COLUMN `claimToken` VARCHAR(32) NULL,
    ADD COLUMN `claimedAt` DATETIME(3) NULL;

CREATE UNIQUE INDEX `Order_claimToken_key` ON `Order`(`claimToken`);
CREATE INDEX `idx_order_claim_token` ON `Order`(`claimToken`);
