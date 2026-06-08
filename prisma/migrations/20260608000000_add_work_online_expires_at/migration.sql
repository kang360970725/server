ALTER TABLE `users`
    ADD COLUMN `workOnlineExpiresAt` DATETIME(3) NULL AFTER `offlineJoinedAt`;

CREATE INDEX `users_workMode_workOnlineExpiresAt_idx` ON `users`(`workMode`, `workOnlineExpiresAt`);

UPDATE `users`
SET `workOnlineExpiresAt` = DATE_ADD(NOW(3), INTERVAL 2 HOUR)
WHERE `userType` = 'STAFF'
  AND `workMode` = 'ONLINE'
  AND `workOnlineExpiresAt` IS NULL;
