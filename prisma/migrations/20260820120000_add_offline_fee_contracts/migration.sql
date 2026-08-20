CREATE TABLE `offline_fee_contracts` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `monthlyAmount` DECIMAL(12, 2) NOT NULL,
  `startMonth` VARCHAR(7) NOT NULL,
  `endMonth` VARCHAR(7) NULL,
  `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  `remark` VARCHAR(255) NULL,
  `createdBy` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `idx_offline_fee_contract_user_status` ON `offline_fee_contracts`(`userId`, `status`);
CREATE INDEX `idx_offline_fee_contract_status_month` ON `offline_fee_contracts`(`status`, `startMonth`);

ALTER TABLE `offline_fee_contracts`
  ADD CONSTRAINT `offline_fee_contracts_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
