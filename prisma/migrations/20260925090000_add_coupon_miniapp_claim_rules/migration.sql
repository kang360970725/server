ALTER TABLE `coupon_templates`
  ADD COLUMN `miniappClaimEnabled` BOOLEAN NOT NULL DEFAULT false AFTER `totalLimit`,
  ADD COLUMN `dailyClaimLimit` INTEGER NULL AFTER `miniappClaimEnabled`;

CREATE INDEX `idx_coupon_template_miniapp_claim`
  ON `coupon_templates`(`miniappClaimEnabled`, `status`, `startAt`, `endAt`);

CREATE INDEX `idx_user_coupon_claim_daily`
  ON `user_coupons`(`templateId`, `sourceType`, `receivedAt`);
