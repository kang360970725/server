ALTER TABLE `users`
    ADD COLUMN `staffDormantFreezeBaseAt` DATETIME(3) NULL AFTER `staffEmploymentStatus`;
