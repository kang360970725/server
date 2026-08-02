ALTER TABLE `equipment_rental_contracts`
  ADD COLUMN `startDate` DATETIME(3) NULL,
  ADD COLUMN `endDate` DATETIME(3) NULL;

UPDATE `equipment_rental_contracts`
SET
  `startDate` = STR_TO_DATE(CONCAT(`startMonth`, '-01'), '%Y-%m-%d'),
  `endDate` = CASE
    WHEN `endMonth` IS NULL THEN NULL
    ELSE LAST_DAY(STR_TO_DATE(CONCAT(`endMonth`, '-01'), '%Y-%m-%d'))
  END
WHERE `startDate` IS NULL;

CREATE INDEX `idx_equipment_rental_contract_status_start_date`
  ON `equipment_rental_contracts`(`status`, `startDate`);
