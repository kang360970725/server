-- chest_user_accounts: track latest redeemed code
ALTER TABLE `chest_user_accounts`
  ADD COLUMN `lastRedeemCodeId` INTEGER NULL;

-- chest_open_records: link winning record with redeemed code
ALTER TABLE `chest_open_records`
  ADD COLUMN `redeemCodeId` INTEGER NULL,
  ADD COLUMN `redeemCode` VARCHAR(64) NULL;

CREATE INDEX `idx_chest_open_record_redeem_code` ON `chest_open_records`(`redeemCodeId`);

ALTER TABLE `chest_user_accounts`
  ADD CONSTRAINT `chest_user_accounts_lastRedeemCodeId_fkey`
  FOREIGN KEY (`lastRedeemCodeId`) REFERENCES `chest_redeem_codes`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `chest_open_records`
  ADD CONSTRAINT `chest_open_records_redeemCodeId_fkey`
  FOREIGN KEY (`redeemCodeId`) REFERENCES `chest_redeem_codes`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
