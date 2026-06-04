ALTER TABLE `wallet_transactions`
  MODIFY `bizType` ENUM(
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
    'MEMBER_RECHARGE_REFUND'
  ) NOT NULL;

CREATE TABLE `user_wechat_bindings` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `platform` ENUM('MINIAPP', 'MP', 'APP') NOT NULL DEFAULT 'MINIAPP',
  `appId` VARCHAR(64) NOT NULL,
  `openId` VARCHAR(128) NOT NULL,
  `unionId` VARCHAR(128) NULL,
  `sessionKey` VARCHAR(255) NULL,
  `nickname` VARCHAR(120) NULL,
  `avatarUrl` VARCHAR(255) NULL,
  `lastLoginAt` DATETIME(3) NULL,
  `lastBindAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uniq_wechat_binding_openid`(`platform`, `appId`, `openId`),
  INDEX `idx_wechat_binding_user_platform`(`userId`, `platform`),
  INDEX `idx_wechat_binding_unionid`(`unionId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_profiles` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `memberCode` VARCHAR(32) NOT NULL,
  `levelCode` VARCHAR(32) NOT NULL DEFAULT 'NONE',
  `totalRechargeAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `totalConsumeAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `annualContribution` INTEGER NOT NULL DEFAULT 0,
  `lastRechargeAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `member_profiles_userId_key`(`userId`),
  UNIQUE INDEX `member_profiles_memberCode_key`(`memberCode`),
  INDEX `idx_member_profile_level_code`(`levelCode`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_level_configs` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(32) NOT NULL,
  `name` VARCHAR(64) NOT NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 100,
  `minRechargeAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `minAnnualContribution` INTEGER NOT NULL DEFAULT 0,
  `benefits` JSON NULL,
  `description` VARCHAR(255) NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `isDefault` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `member_level_configs_code_key`(`code`),
  INDEX `idx_member_level_cfg_enabled_sort`(`enabled`, `sortOrder`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_point_accounts` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `availablePoints` INTEGER NOT NULL DEFAULT 0,
  `totalEarnedPoints` INTEGER NOT NULL DEFAULT 0,
  `totalSpentPoints` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `member_point_accounts_userId_key`(`userId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_point_transactions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `direction` ENUM('IN', 'OUT') NOT NULL,
  `bizType` ENUM('RECHARGE_GIFT', 'ORDER_CONSUME', 'SIGN_IN', 'ADMIN_ADJUST', 'ORDER_DEDUCT') NOT NULL,
  `points` INTEGER NOT NULL,
  `balanceAfter` INTEGER NOT NULL,
  `sourceType` VARCHAR(32) NOT NULL,
  `sourceId` INTEGER NULL,
  `remark` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `idx_member_point_tx_user_time`(`userId`, `createdAt`),
  INDEX `idx_member_point_tx_biz_time`(`bizType`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_recharge_plans` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(64) NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  `bonusAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `giftPoints` INTEGER NOT NULL DEFAULT 0,
  `couponText` VARCHAR(120) NULL,
  `badgeText` VARCHAR(32) NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 100,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `idx_member_recharge_plan_enabled_sort`(`enabled`, `sortOrder`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_recharge_orders` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `rechargeNo` VARCHAR(64) NOT NULL,
  `userId` INTEGER NOT NULL,
  `planId` INTEGER NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  `bonusAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `grantedAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `giftPoints` INTEGER NOT NULL DEFAULT 0,
  `payAmount` DECIMAL(10, 2) NOT NULL,
  `channel` VARCHAR(20) NOT NULL DEFAULT 'WECHAT',
  `status` ENUM('PENDING', 'SUCCESS', 'FAILED', 'CLOSED') NOT NULL DEFAULT 'PENDING',
  `payerOpenid` VARCHAR(128) NULL,
  `prepayId` VARCHAR(128) NULL,
  `transactionId` VARCHAR(128) NULL,
  `notifyRaw` JSON NULL,
  `paidAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `member_recharge_orders_rechargeNo_key`(`rechargeNo`),
  INDEX `idx_member_recharge_order_user_status`(`userId`, `status`, `createdAt`),
  INDEX `idx_member_recharge_order_plan`(`planId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `user_wechat_bindings`
  ADD CONSTRAINT `user_wechat_bindings_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `member_profiles`
  ADD CONSTRAINT `member_profiles_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `member_point_accounts`
  ADD CONSTRAINT `member_point_accounts_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `member_point_transactions`
  ADD CONSTRAINT `member_point_transactions_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `member_recharge_orders`
  ADD CONSTRAINT `member_recharge_orders_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `member_recharge_orders`
  ADD CONSTRAINT `member_recharge_orders_planId_fkey`
  FOREIGN KEY (`planId`) REFERENCES `member_recharge_plans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
