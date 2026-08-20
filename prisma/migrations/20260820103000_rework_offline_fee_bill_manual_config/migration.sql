ALTER TABLE `offline_fee_bills`
  ADD COLUMN `dueAt` DATETIME(3) NULL AFTER `lastRemindAt`,
  ADD COLUMN `remark` VARCHAR(255) NULL AFTER `dueAt`,
  ADD COLUMN `createdBy` INTEGER NULL AFTER `remark`;

ALTER TABLE `offline_fee_bill_payments`
  MODIFY COLUMN `source` ENUM('WITHDRAWAL', 'MANUAL', 'EXTERNAL', 'WAIVER') NOT NULL DEFAULT 'WITHDRAWAL';

CREATE INDEX `idx_offline_fee_bill_due_at` ON `offline_fee_bills`(`dueAt`);
CREATE INDEX `idx_offline_fee_bill_created_by` ON `offline_fee_bills`(`createdBy`);
CREATE INDEX `idx_offline_fee_bill_payments_source` ON `offline_fee_bill_payments`(`source`);
