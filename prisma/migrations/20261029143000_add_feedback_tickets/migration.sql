ALTER TABLE `user_notifications`
  MODIFY COLUMN `type` ENUM('SYSTEM_ANNOUNCEMENT','DISPATCH_ASSIGNED','DISPATCH_ARCHIVED','DISPATCH_COMPLETED','CS_DUTY_SUBSTITUTION','ORDER_UNPAID_REMINDER','ORDER_UNPAID_AUTO_DEDUCTED','FEEDBACK_REPLY') NOT NULL;

CREATE TABLE `feedback_tickets` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `ticketNo` VARCHAR(64) NOT NULL,
  `userId` INTEGER NOT NULL,
  `category` VARCHAR(32) NOT NULL,
  `title` VARCHAR(120) NOT NULL,
  `content` TEXT NOT NULL,
  `contact` VARCHAR(120) NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  `handledBy` INTEGER NULL,
  `lastReplyAt` DATETIME(3) NULL,
  `closedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `feedback_tickets_ticketNo_key`(`ticketNo`),
  INDEX `idx_feedback_ticket_user_created`(`userId`, `createdAt`),
  INDEX `idx_feedback_ticket_status_updated`(`status`, `updatedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `feedback_replies` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `ticketId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `authorType` VARCHAR(16) NOT NULL,
  `content` TEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `idx_feedback_reply_ticket_created`(`ticketId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `feedback_tickets` ADD CONSTRAINT `feedback_tickets_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `feedback_tickets` ADD CONSTRAINT `feedback_tickets_handledBy_fkey` FOREIGN KEY (`handledBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `feedback_replies` ADD CONSTRAINT `feedback_replies_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `feedback_tickets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `feedback_replies` ADD CONSTRAINT `feedback_replies_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
