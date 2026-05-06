ALTER TABLE `chest_open_records`
  ADD COLUMN `verifiedAt` DATETIME(3) NULL,
  ADD COLUMN `verifiedBy` INTEGER NULL,
  ADD COLUMN `verifyRemark` VARCHAR(255) NULL;

CREATE INDEX `idx_chest_open_record_verify_time` ON `chest_open_records`(`verifiedAt`);
