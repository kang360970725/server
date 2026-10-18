-- 服务者不再使用手动上下线及在线租约，正常在职账号统一保持在线。
UPDATE `users`
SET `workMode` = 'ONLINE',
    `workOnlineExpiresAt` = NULL,
    `offlineJoinedAt` = NULL
WHERE `userType` = 'STAFF'
  AND `status` = 'ACTIVE'
  AND `staffEmploymentStatus` = 'ACTIVE';
