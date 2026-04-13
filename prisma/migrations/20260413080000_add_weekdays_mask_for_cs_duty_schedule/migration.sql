-- AlterTable
ALTER TABLE `cs_duty_schedules`
  ADD COLUMN `weekdaysMask` INTEGER NOT NULL DEFAULT 0 AFTER `weekday`;

-- Backfill: 兼容历史数据（单 weekday 转位图）
UPDATE `cs_duty_schedules`
SET `weekdaysMask` = (1 << `weekday`)
WHERE `weekdaysMask` = 0;

-- CreateIndex
CREATE INDEX `idx_cs_duty_mask` ON `cs_duty_schedules`(`weekdaysMask`, `enabled`);
