-- CreateIndex
CREATE INDEX `user_logs_target` ON `user_logs`(`targetType`, `targetId`);

-- CreateIndex
CREATE INDEX `user_logs_action` ON `user_logs`(`action`);

-- CreateIndex
CREATE INDEX `user_logs_createdAt` ON `user_logs`(`createdAt`);
