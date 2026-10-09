ALTER TABLE `users`
  ADD COLUMN `staffBlacklistReason` VARCHAR(255) NULL;

UPDATE `users`
SET `staffBlacklistReason` = '历史黑名单记录'
WHERE `staffEmploymentStatus` = 'BLACKLISTED'
  AND `staffBlacklistReason` IS NULL;
