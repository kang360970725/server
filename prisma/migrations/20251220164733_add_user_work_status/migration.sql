-- AlterTable
ALTER TABLE `users` ADD COLUMN `workStatus` ENUM('IDLE', 'WORKING', 'RESTING') NOT NULL DEFAULT 'IDLE';

-- CreateIndex
CREATE INDEX `users_workStatus_idx` ON `users`(`workStatus`);
