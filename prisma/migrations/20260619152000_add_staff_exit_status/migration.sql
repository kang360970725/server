-- Add staff employment status fields
ALTER TABLE `users`
  ADD COLUMN `staffEmploymentStatus` ENUM('ACTIVE', 'EXITED', 'BLACKLISTED') NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN `staffCooldownUntil` DATETIME(3) NULL,
  ADD COLUMN `staffExitedAt` DATETIME(3) NULL;

CREATE INDEX `users_userType_staffEmploymentStatus_idx`
  ON `users`(`userType`, `staffEmploymentStatus`);

-- Extend wallet / deposit biz enums
ALTER TABLE `wallet_transactions`
  MODIFY COLUMN `bizType` ENUM(
    'SETTLEMENT_EARNING',
    'SETTLEMENT_EARNING_BASE',
    'SETTLEMENT_EARNING_CARRY',
    'SETTLEMENT_BOMB_LOSS',
    'SETTLEMENT_EARNING_CS',
    'RELEASE_FROZEN',
    'REFUND_REVERSAL',
    'WITHDRAW_RESERVE',
    'WITHDRAW_RELEASE',
    'WITHDRAW_PAYOUT',
    'DEPOSIT_REFUND',
    'DEPOSIT_ADD',
    'DEPOSIT_DEDUCT',
    'OFFLINE_FEE_PAYMENT',
    'SETTLEMENT_REVERSAL',
    'SETTLEMENT_RECALC',
    'MEMBER_RECHARGE',
    'MEMBER_RECHARGE_BONUS',
    'MEMBER_ORDER_CONSUME',
    'MEMBER_RECHARGE_REFUND',
    'STAFF_EXIT_RELEASE',
    'STAFF_EXIT_CLEAR'
  ) NOT NULL DEFAULT 'SETTLEMENT_EARNING';

CREATE TABLE IF NOT EXISTS `wallet_deposit_transactions` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `userId` INT NOT NULL,
  `amount` DECIMAL(10,2) NOT NULL,
  `bizType` ENUM(
    'WITHDRAW_PERCENT',
    'REWARD_TRANSFER',
    'MANUAL_DEPOSIT',
    'PENALTY_DEDUCT',
    'DEPOSIT_REFUND',
    'STAFF_EXIT_RELEASE',
    'STAFF_EXIT_CLEAR'
  ) NOT NULL,
  `remark` VARCHAR(255) NULL,
  `operatorId` INT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `wallet_deposit_transactions_userId_idx`(`userId`),
  CONSTRAINT `wallet_deposit_transactions_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE `wallet_deposit_transactions`
  MODIFY COLUMN `bizType` ENUM(
    'WITHDRAW_PERCENT',
    'REWARD_TRANSFER',
    'MANUAL_DEPOSIT',
    'PENALTY_DEDUCT',
    'DEPOSIT_REFUND',
    'STAFF_EXIT_RELEASE',
    'STAFF_EXIT_CLEAR'
  ) NOT NULL;
