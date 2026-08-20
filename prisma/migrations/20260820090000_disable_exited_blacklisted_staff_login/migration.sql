-- 历史黑名单服务者：立即禁用账号，禁止继续登录后台或通过旧 token 访问。
UPDATE `users`
SET
  `status` = 'DISABLED',
  `canWithdraw` = false,
  `workStatus` = 'IDLE',
  `workOnlineExpiresAt` = NULL
WHERE
  `userType` = 'STAFF'
  AND `staffEmploymentStatus` = 'BLACKLISTED'
  AND `status` <> 'DISABLED';

-- 历史已退店服务者：退店满 72 小时后禁用账号。
-- staffExitedAt 为空的老数据用 updatedAt / createdAt 兜底判断。
UPDATE `users`
SET
  `status` = 'DISABLED',
  `canWithdraw` = false,
  `workStatus` = 'IDLE',
  `workOnlineExpiresAt` = NULL
WHERE
  `userType` = 'STAFF'
  AND `staffEmploymentStatus` = 'EXITED'
  AND `status` <> 'DISABLED'
  AND COALESCE(`staffExitedAt`, `updatedAt`, `createdAt`) <= DATE_SUB(NOW(3), INTERVAL 72 HOUR);
