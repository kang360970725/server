-- Excellent staff roster and renewal bonus eligibility snapshot.
CREATE TABLE `excellent_staff` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  `assignedBy` INTEGER NULL,
  `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `removedBy` INTEGER NULL,
  `removedAt` DATETIME(3) NULL,
  `remark` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `excellent_staff_userId_key` (`userId`),
  INDEX `idx_excellent_staff_status_time` (`status`, `assignedAt`),
  INDEX `excellent_staff_assignedBy_idx` (`assignedBy`),
  INDEX `excellent_staff_removedBy_idx` (`removedBy`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `excellent_staff`
  ADD CONSTRAINT `excellent_staff_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `excellent_staff`
  ADD CONSTRAINT `excellent_staff_assignedBy_fkey`
  FOREIGN KEY (`assignedBy`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `excellent_staff`
  ADD CONSTRAINT `excellent_staff_removedBy_fkey`
  FOREIGN KEY (`removedBy`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `order_renewal_groups`
  ADD COLUMN `bonusEligibleUserIds` JSON NULL,
  ADD COLUMN `bonusEligibleSnapshot` JSON NULL;
