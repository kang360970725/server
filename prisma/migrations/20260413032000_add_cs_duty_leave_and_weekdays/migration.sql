-- AlterEnum
ALTER TABLE `user_notifications`
    MODIFY `type` ENUM('SYSTEM_ANNOUNCEMENT', 'DISPATCH_ASSIGNED', 'DISPATCH_ARCHIVED', 'DISPATCH_COMPLETED', 'CS_DUTY_SUBSTITUTION') NOT NULL;

-- CreateTable
CREATE TABLE `cs_duty_leaves` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `substituteUserId` INTEGER NOT NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `reason` VARCHAR(255) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdBy` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `idx_cs_duty_leave_user_time`(`userId`, `enabled`, `startAt`, `endAt`),
    INDEX `idx_cs_duty_leave_sub_time`(`substituteUserId`, `enabled`, `startAt`, `endAt`),
    INDEX `idx_cs_duty_leave_time`(`enabled`, `startAt`, `endAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `cs_duty_leaves` ADD CONSTRAINT `cs_duty_leaves_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cs_duty_leaves` ADD CONSTRAINT `cs_duty_leaves_substituteUserId_fkey` FOREIGN KEY (`substituteUserId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cs_duty_leaves` ADD CONSTRAINT `cs_duty_leaves_createdBy_fkey` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
