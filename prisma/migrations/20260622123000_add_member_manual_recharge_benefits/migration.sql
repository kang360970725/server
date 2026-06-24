ALTER TABLE `member_recharge_plans`
  ADD COLUMN `giftGrowthValue` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `couponBenefits` JSON NULL;

ALTER TABLE `member_recharge_orders`
  ADD COLUMN `giftGrowthValue` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `couponBenefits` JSON NULL,
  ADD COLUMN `operatorId` INTEGER NULL,
  ADD COLUMN `remark` VARCHAR(255) NULL;
