-- 罚单系统核心：处罚条例、罚单、申诉、罚款资金池

CREATE TABLE `penalty_rules` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(32) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `category` ENUM('SERVICE', 'ATTENDANCE', 'DISCIPLINE', 'SAFETY', 'OTHER') NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  `description` VARCHAR(255) NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdBy` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `penalty_rules_code_key`(`code`),
  INDEX `idx_penalty_rule_enabled_sort`(`enabled`, `sortOrder`),
  INDEX `idx_penalty_rule_category`(`category`, `enabled`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `penalty_tickets` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `ticketNo` VARCHAR(32) NOT NULL,
  `userId` INTEGER NOT NULL,
  `creatorId` INTEGER NULL,
  `appealReviewerId` INTEGER NULL,
  `status` ENUM('PENDING_CONFIRM', 'APPEAL_PENDING', 'EFFECTIVE', 'INVALID') NOT NULL DEFAULT 'PENDING_CONFIRM',
  `appealStatus` ENUM('NONE', 'PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'NONE',
  `ruleAmount` DECIMAL(10, 2) NOT NULL,
  `finalAmount` DECIMAL(10, 2) NOT NULL,
  `deductedAmount` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `deductedAt` DATETIME(3) NULL,
  `deductWalletTxId` INTEGER NULL,
  `reason` VARCHAR(255) NULL,
  `sameCategoryStats` JSON NULL,
  `confirmAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `penalty_tickets_ticketNo_key`(`ticketNo`),
  INDEX `idx_penalty_ticket_user_status`(`userId`, `status`, `createdAt`),
  INDEX `idx_penalty_ticket_status`(`status`, `createdAt`),
  INDEX `idx_penalty_ticket_appeal`(`appealStatus`, `createdAt`),
  INDEX `idx_penalty_ticket_creator`(`creatorId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `penalty_ticket_details` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `ticketId` INTEGER NOT NULL,
  `ruleId` INTEGER NULL,
  `ruleCodeSnapshot` VARCHAR(32) NULL,
  `ruleNameSnapshot` VARCHAR(120) NOT NULL,
  `ruleCategorySnapshot` ENUM('SERVICE', 'ATTENDANCE', 'DISCIPLINE', 'SAFETY', 'OTHER') NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  `descriptionSnapshot` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `idx_penalty_ticket_detail_ticket`(`ticketId`),
  INDEX `idx_penalty_ticket_detail_category`(`ruleCategorySnapshot`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `penalty_appeals` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `ticketId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `content` TEXT NOT NULL,
  `status` ENUM('NONE', 'PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  `reviewedBy` INTEGER NULL,
  `reviewedAt` DATETIME(3) NULL,
  `reviewRemark` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `penalty_appeals_ticketId_key`(`ticketId`),
  INDEX `idx_penalty_appeal_user`(`userId`, `createdAt`),
  INDEX `idx_penalty_appeal_status`(`status`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `penalty_fund_pools` (
  `id` INTEGER NOT NULL,
  `totalIn` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `totalOut` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `balance` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `penalty_fund_flows` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `poolId` INTEGER NOT NULL DEFAULT 1,
  `ticketId` INTEGER NULL,
  `userId` INTEGER NULL,
  `direction` ENUM('IN', 'OUT') NOT NULL,
  `bizType` ENUM('PENALTY_DEDUCT', 'APPEAL_REFUND', 'MANUAL_ADJUST') NOT NULL,
  `amount` DECIMAL(10, 2) NOT NULL,
  `beforeBalance` DECIMAL(12, 2) NOT NULL,
  `afterBalance` DECIMAL(12, 2) NOT NULL,
  `walletTxId` INTEGER NULL,
  `operatorId` INTEGER NULL,
  `remark` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `uniq_penalty_flow_ticket_biz`(`ticketId`, `bizType`),
  INDEX `idx_penalty_fund_flow_created`(`createdAt`),
  INDEX `idx_penalty_fund_flow_user`(`userId`, `createdAt`),
  INDEX `idx_penalty_fund_flow_biz`(`bizType`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `penalty_rules`
  ADD CONSTRAINT `penalty_rules_createdBy_fkey`
  FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `penalty_tickets`
  ADD CONSTRAINT `penalty_tickets_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `penalty_tickets`
  ADD CONSTRAINT `penalty_tickets_creatorId_fkey`
  FOREIGN KEY (`creatorId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `penalty_tickets`
  ADD CONSTRAINT `penalty_tickets_appealReviewerId_fkey`
  FOREIGN KEY (`appealReviewerId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `penalty_ticket_details`
  ADD CONSTRAINT `penalty_ticket_details_ticketId_fkey`
  FOREIGN KEY (`ticketId`) REFERENCES `penalty_tickets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `penalty_ticket_details`
  ADD CONSTRAINT `penalty_ticket_details_ruleId_fkey`
  FOREIGN KEY (`ruleId`) REFERENCES `penalty_rules`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `penalty_appeals`
  ADD CONSTRAINT `penalty_appeals_ticketId_fkey`
  FOREIGN KEY (`ticketId`) REFERENCES `penalty_tickets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `penalty_appeals`
  ADD CONSTRAINT `penalty_appeals_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `penalty_appeals`
  ADD CONSTRAINT `penalty_appeals_reviewedBy_fkey`
  FOREIGN KEY (`reviewedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `penalty_fund_flows`
  ADD CONSTRAINT `penalty_fund_flows_poolId_fkey`
  FOREIGN KEY (`poolId`) REFERENCES `penalty_fund_pools`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `penalty_fund_flows`
  ADD CONSTRAINT `penalty_fund_flows_ticketId_fkey`
  FOREIGN KEY (`ticketId`) REFERENCES `penalty_tickets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `penalty_fund_flows`
  ADD CONSTRAINT `penalty_fund_flows_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO `penalty_fund_pools` (`id`, `totalIn`, `totalOut`, `balance`, `createdAt`, `updatedAt`)
VALUES (1, 0.00, 0.00, 0.00, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
