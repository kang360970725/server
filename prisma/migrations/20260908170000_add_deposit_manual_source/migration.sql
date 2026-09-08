ALTER TABLE `wallet_deposit_transactions`
  ADD COLUMN `manualSource` VARCHAR(32) NULL AFTER `operatorId`;
