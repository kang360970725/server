ALTER TABLE `offline_fee_contracts`
  ADD COLUMN `startDate` DATETIME(3) NULL,
  ADD COLUMN `endDate` DATETIME(3) NULL;

UPDATE `offline_fee_contracts`
SET
  `startDate` = STR_TO_DATE(CONCAT(`startMonth`, '-20'), '%Y-%m-%d'),
  `endDate` = CASE
    WHEN `endMonth` IS NULL THEN NULL
    ELSE STR_TO_DATE(CONCAT(`endMonth`, '-20'), '%Y-%m-%d')
  END
WHERE `startDate` IS NULL;

CREATE INDEX `idx_offline_fee_contract_status_start_date`
  ON `offline_fee_contracts`(`status`, `startDate`);
