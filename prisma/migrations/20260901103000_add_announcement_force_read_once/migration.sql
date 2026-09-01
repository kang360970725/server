ALTER TABLE `system_announcements`
  ADD COLUMN `forceReadOnce` BOOLEAN NOT NULL DEFAULT false AFTER `forceRead`,
  ADD INDEX `idx_announcement_force_read_once` (`forceReadOnce`);
