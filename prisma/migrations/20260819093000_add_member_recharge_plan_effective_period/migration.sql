ALTER TABLE `member_recharge_plans`
  ADD COLUMN `effectiveFrom` DATETIME(3) NULL,
  ADD COLUMN `effectiveTo` DATETIME(3) NULL;

CREATE INDEX `idx_member_recharge_plan_effective`
  ON `member_recharge_plans` (`enabled`, `effectiveFrom`, `effectiveTo`, `sortOrder`);
