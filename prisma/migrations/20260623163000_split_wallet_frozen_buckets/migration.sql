ALTER TABLE `wallet_accounts`
  ADD COLUMN `earningFrozenBalance` DECIMAL(10, 1) NOT NULL DEFAULT 0.0,
  ADD COLUMN `withdrawFrozenBalance` DECIMAL(10, 1) NOT NULL DEFAULT 0.0;
