SET @sql = IF(
  (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='member_recharge_orders' AND COLUMN_NAME='levelBeforeCode') = 0,
  'ALTER TABLE `member_recharge_orders` ADD COLUMN `levelBeforeCode` VARCHAR(32) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = IF(
  (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='member_recharge_orders' AND COLUMN_NAME='levelAfterCode') = 0,
  'ALTER TABLE `member_recharge_orders` ADD COLUMN `levelAfterCode` VARCHAR(32) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

ALTER TABLE `Order`
  ADD COLUMN `memberDiscountAmount` DECIMAL(10,2) NOT NULL DEFAULT 0.00;

ALTER TABLE `user_coupons`
  ADD COLUMN `sourceType` VARCHAR(32) NULL,
  ADD COLUMN `sourceId` INTEGER NULL,
  ADD INDEX `idx_user_coupon_source` (`sourceType`,`sourceId`);

CREATE TABLE `member_benefits` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(64) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `description` TEXT NULL,
  `category` VARCHAR(32) NOT NULL DEFAULT 'SERVICE',
  `unitName` VARCHAR(24) NOT NULL DEFAULT '次',
  `unitValue` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `refundableDeduction` BOOLEAN NOT NULL DEFAULT false,
  `reviewRestricted` BOOLEAN NOT NULL DEFAULT false,
  `requiresVerification` BOOLEAN NOT NULL DEFAULT true,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 100,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `member_benefits_code_key` (`code`),
  INDEX `idx_member_benefit_enabled_sort` (`enabled`, `sortOrder`),
  INDEX `idx_member_benefit_review_restricted` (`reviewRestricted`, `enabled`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_level_benefits` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `levelId` INTEGER NOT NULL,
  `benefitId` INTEGER NOT NULL,
  `grantMode` VARCHAR(32) NOT NULL DEFAULT 'IDENTITY',
  `quantity` DECIMAL(12,2) NULL,
  `unlimited` BOOLEAN NOT NULL DEFAULT false,
  `validityDays` INTEGER NULL,
  `config` JSON NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT true,
  `sortOrder` INTEGER NOT NULL DEFAULT 100,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uniq_member_level_benefit` (`levelId`, `benefitId`),
  INDEX `idx_member_level_benefit_enabled` (`benefitId`, `enabled`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_benefit_grants` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `benefitId` INTEGER NOT NULL,
  `levelCodeSnapshot` VARCHAR(32) NOT NULL,
  `benefitNameSnapshot` VARCHAR(120) NOT NULL,
  `unitNameSnapshot` VARCHAR(24) NOT NULL,
  `unitValueSnapshot` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `sourceType` VARCHAR(32) NOT NULL,
  `sourceId` INTEGER NULL,
  `totalQuantity` DECIMAL(12,2) NULL,
  `usedQuantity` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `unlimited` BOOLEAN NOT NULL DEFAULT false,
  `status` VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  `periodStart` DATETIME(3) NULL,
  `periodEnd` DATETIME(3) NULL,
  `expiresAt` DATETIME(3) NULL,
  `grantedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `idx_member_benefit_grant_user_status` (`userId`, `status`, `expiresAt`),
  INDEX `idx_member_benefit_grant_source` (`sourceType`, `sourceId`),
  INDEX `idx_member_benefit_grant_benefit` (`benefitId`, `grantedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_benefit_usages` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `grantId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `quantity` DECIMAL(12,2) NOT NULL,
  `deductedValue` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `sourceType` VARCHAR(32) NULL,
  `sourceId` INTEGER NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'CONFIRMED',
  `operatorId` INTEGER NULL,
  `remark` VARCHAR(255) NULL,
  `usedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `reversedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `idx_member_benefit_usage_user_time` (`userId`, `usedAt`),
  INDEX `idx_member_benefit_usage_source` (`sourceType`, `sourceId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_level_operations` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `beforeLevelCode` VARCHAR(32) NOT NULL,
  `afterLevelCode` VARCHAR(32) NOT NULL,
  `operationType` VARCHAR(32) NOT NULL,
  `sourceType` VARCHAR(32) NULL,
  `sourceId` INTEGER NULL,
  `operatorId` INTEGER NULL,
  `remark` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `idx_member_level_operation_user_time` (`userId`, `createdAt`),
  INDEX `idx_member_level_operation_source` (`sourceType`, `sourceId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_balance_lots` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `userId` INTEGER NOT NULL,
  `rechargeOrderId` INTEGER NULL,
  `sourceType` VARCHAR(32) NOT NULL DEFAULT 'RECHARGE',
  `principalInitial` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `principalRemaining` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `bonusInitial` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `bonusRemaining` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `member_balance_lots_rechargeOrderId_key` (`rechargeOrderId`),
  INDEX `idx_member_balance_lot_user_status` (`userId`,`status`,`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_balance_lot_usages` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `lotId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `sourceType` VARCHAR(32) NOT NULL,
  `sourceId` INTEGER NOT NULL,
  `principalAmount` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `bonusAmount` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `status` VARCHAR(24) NOT NULL DEFAULT 'CONSUMED',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `reversedAt` DATETIME(3) NULL,
  UNIQUE INDEX `uniq_member_balance_lot_usage_source` (`lotId`,`sourceType`,`sourceId`),
  INDEX `idx_member_balance_lot_usage_user_time` (`userId`,`createdAt`),
  INDEX `idx_member_balance_lot_usage_source` (`sourceType`,`sourceId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `member_recharge_refunds` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `refundNo` VARCHAR(64) NOT NULL,
  `rechargeOrderId` INTEGER NOT NULL,
  `userId` INTEGER NOT NULL,
  `originalPrincipal` DECIMAL(12,2) NOT NULL,
  `consumedPrincipal` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `refundablePrincipal` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `recoveredBonus` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `usedBenefitValue` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `serviceFeeRate` DECIMAL(6,4) NOT NULL DEFAULT 0.30,
  `serviceFeeAmount` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `actualRefundAmount` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `levelBeforeRefund` VARCHAR(32) NOT NULL,
  `levelAfterRefund` VARCHAR(32) NOT NULL,
  `suggestedLevelCode` VARCHAR(32) NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'SUCCESS',
  `operatorId` INTEGER NULL,
  `remark` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `member_recharge_refunds_refundNo_key` (`refundNo`),
  INDEX `idx_member_recharge_refund_user_time` (`userId`,`createdAt`),
  INDEX `idx_member_recharge_refund_order_status` (`rechargeOrderId`,`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `member_level_benefits`
  ADD CONSTRAINT `member_level_benefits_levelId_fkey` FOREIGN KEY (`levelId`) REFERENCES `member_level_configs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `member_level_benefits_benefitId_fkey` FOREIGN KEY (`benefitId`) REFERENCES `member_benefits`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `member_benefit_grants`
  ADD CONSTRAINT `member_benefit_grants_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `member_benefit_grants_benefitId_fkey` FOREIGN KEY (`benefitId`) REFERENCES `member_benefits`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `member_benefit_usages`
  ADD CONSTRAINT `member_benefit_usages_grantId_fkey` FOREIGN KEY (`grantId`) REFERENCES `member_benefit_grants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `member_benefit_usages_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `member_level_operations`
  ADD CONSTRAINT `member_level_operations_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `member_level_operations_operatorId_fkey` FOREIGN KEY (`operatorId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `member_balance_lots`
  ADD CONSTRAINT `member_balance_lots_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `member_balance_lots_rechargeOrderId_fkey` FOREIGN KEY (`rechargeOrderId`) REFERENCES `member_recharge_orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `member_balance_lot_usages`
  ADD CONSTRAINT `member_balance_lot_usages_lotId_fkey` FOREIGN KEY (`lotId`) REFERENCES `member_balance_lots`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `member_recharge_refunds`
  ADD CONSTRAINT `member_recharge_refunds_rechargeOrderId_fkey` FOREIGN KEY (`rechargeOrderId`) REFERENCES `member_recharge_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `member_recharge_refunds_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO `member_benefits`
  (`code`,`name`,`description`,`category`,`unitName`,`unitValue`,`refundableDeduction`,`reviewRestricted`,`requiresVerification`,`enabled`,`sortOrder`,`createdAt`,`updatedAt`)
VALUES
  ('ORDER_DISCOUNT','下单折扣','会员永久基础下单折扣','ORDER_DISCOUNT','项',0,false,false,false,true,10,NOW(3),NOW(3)),
  ('RENTAL_FEE_DISCOUNT','商行租号手续费折扣','仅作用于租号手续费，不改变租金和押金','RENTAL_FEE_DISCOUNT','项',0,false,false,false,true,20,NOW(3),NOW(3)),
  ('PRIORITY_DISPATCH','优先派单','会员订单优先派单身份','SERVICE','项',0,false,false,false,true,30,NOW(3),NOW(3)),
  ('KOOK_CHANNEL','KOOK冠名专属频道','KOOK冠名专属频道资格','SERVICE','项',0,false,false,true,true,40,NOW(3),NOW(3)),
  ('DESIGNATED_GROUP','指定陪玩小群','指定人数的陪玩小群服务','SERVICE','人',0,false,false,true,true,50,NOW(3),NOW(3)),
  ('PRIORITY_AFTER_SALES','1对1优先售后','一对一优先售后处理','SERVICE','项',0,false,false,false,true,60,NOW(3),NOW(3)),
  ('MONTHLY_NEW_ORDER','每月新单体验（成本价）','按自然月发放，月底失效','EXPERIENCE','次',0,true,false,true,true,70,NOW(3),NOW(3)),
  ('MONTHLY_STREAMER','每月主播专属下单陪玩资格','按自然月发放，月底失效','EXPERIENCE','次',0,true,false,true,true,80,NOW(3),NOW(3)),
  ('MONTHLY_EXAMINER','每月考官体验','按自然月发放，月底失效','EXPERIENCE','次',0,true,false,true,true,90,NOW(3),NOW(3)),
  ('MONTHLY_EVENT','每月蓝猫赛事免费参加资格','按自然月发放，月底失效','EXPERIENCE','次',0,true,false,true,true,100,NOW(3),NOW(3)),
  ('VIDEO_EDITING','精彩视频剪辑','升级即得，逐级升级分别领取','SERVICE','条',0,true,false,true,true,110,NOW(3),NOW(3)),
  ('FREE_RUN','免费跑刀','升级即得，每份为1000W','ITEM','1000W',0,true,false,true,true,120,NOW(3),NOW(3)),
  ('FREE_AW_AMMO','免费AW子弹','升级即得','ITEM','发',0,true,false,true,true,130,NOW(3),NOW(3));

INSERT INTO `member_level_benefits`
  (`levelId`,`benefitId`,`grantMode`,`quantity`,`unlimited`,`validityDays`,`config`,`enabled`,`sortOrder`,`createdAt`,`updatedAt`)
SELECT l.id,b.id,x.grantMode,x.quantity,x.unlimited,NULL,x.config,true,x.sortOrder,NOW(3),NOW(3)
FROM (
  SELECT 'V1' levelCode,'ORDER_DISCOUNT' benefitCode,'AUTOMATIC_DISCOUNT' grantMode,NULL quantity,false unlimited,JSON_OBJECT('rate',0.98,'excludedProjectTypes',JSON_ARRAY('EXPERIENCE')) config,10 sortOrder UNION ALL
  SELECT 'V2','ORDER_DISCOUNT','AUTOMATIC_DISCOUNT',NULL,false,JSON_OBJECT('rate',0.97,'excludedProjectTypes',JSON_ARRAY('EXPERIENCE')),10 UNION ALL
  SELECT 'V3','ORDER_DISCOUNT','AUTOMATIC_DISCOUNT',NULL,false,JSON_OBJECT('rate',0.95,'excludedProjectTypes',JSON_ARRAY('EXPERIENCE')),10 UNION ALL
  SELECT 'V4','ORDER_DISCOUNT','AUTOMATIC_DISCOUNT',NULL,false,JSON_OBJECT('rate',0.95,'excludedProjectTypes',JSON_ARRAY('EXPERIENCE')),10 UNION ALL
  SELECT 'V5','ORDER_DISCOUNT','AUTOMATIC_DISCOUNT',NULL,false,JSON_OBJECT('rate',0.95,'excludedProjectTypes',JSON_ARRAY('EXPERIENCE')),10 UNION ALL
  SELECT 'V6','ORDER_DISCOUNT','AUTOMATIC_DISCOUNT',NULL,false,JSON_OBJECT('rate',0.92,'excludedProjectTypes',JSON_ARRAY('EXPERIENCE')),10 UNION ALL
  SELECT 'V2','RENTAL_FEE_DISCOUNT','AUTOMATIC_DISCOUNT',NULL,false,JSON_OBJECT('rate',0.80),20 UNION ALL
  SELECT 'V3','RENTAL_FEE_DISCOUNT','AUTOMATIC_DISCOUNT',NULL,false,JSON_OBJECT('rate',0.70),20 UNION ALL
  SELECT 'V4','RENTAL_FEE_DISCOUNT','AUTOMATIC_DISCOUNT',NULL,false,JSON_OBJECT('rate',0.60),20 UNION ALL
  SELECT 'V5','RENTAL_FEE_DISCOUNT','AUTOMATIC_DISCOUNT',NULL,false,JSON_OBJECT('rate',0.50),20 UNION ALL
  SELECT 'V6','RENTAL_FEE_DISCOUNT','AUTOMATIC_DISCOUNT',NULL,false,JSON_OBJECT('rate',0.10),20 UNION ALL
  SELECT 'V1','PRIORITY_DISPATCH','IDENTITY',NULL,true,NULL,30 UNION ALL SELECT 'V2','PRIORITY_DISPATCH','IDENTITY',NULL,true,NULL,30 UNION ALL SELECT 'V3','PRIORITY_DISPATCH','IDENTITY',NULL,true,NULL,30 UNION ALL SELECT 'V4','PRIORITY_DISPATCH','IDENTITY',NULL,true,NULL,30 UNION ALL SELECT 'V5','PRIORITY_DISPATCH','IDENTITY',NULL,true,NULL,30 UNION ALL SELECT 'V6','PRIORITY_DISPATCH','IDENTITY',NULL,true,NULL,30 UNION ALL
  SELECT 'V1','KOOK_CHANNEL','IDENTITY',NULL,true,NULL,40 UNION ALL SELECT 'V2','KOOK_CHANNEL','IDENTITY',NULL,true,NULL,40 UNION ALL SELECT 'V3','KOOK_CHANNEL','IDENTITY',NULL,true,NULL,40 UNION ALL SELECT 'V4','KOOK_CHANNEL','IDENTITY',NULL,true,NULL,40 UNION ALL SELECT 'V5','KOOK_CHANNEL','IDENTITY',NULL,true,NULL,40 UNION ALL SELECT 'V6','KOOK_CHANNEL','IDENTITY',NULL,true,NULL,40 UNION ALL
  SELECT 'V2','DESIGNATED_GROUP','IDENTITY',2,false,NULL,50 UNION ALL SELECT 'V3','DESIGNATED_GROUP','IDENTITY',3,false,NULL,50 UNION ALL SELECT 'V4','DESIGNATED_GROUP','IDENTITY',4,false,NULL,50 UNION ALL SELECT 'V5','DESIGNATED_GROUP','IDENTITY',5,false,NULL,50 UNION ALL SELECT 'V6','DESIGNATED_GROUP','IDENTITY',6,false,NULL,50 UNION ALL
  SELECT 'V2','PRIORITY_AFTER_SALES','IDENTITY',NULL,true,NULL,60 UNION ALL SELECT 'V3','PRIORITY_AFTER_SALES','IDENTITY',NULL,true,NULL,60 UNION ALL SELECT 'V4','PRIORITY_AFTER_SALES','IDENTITY',NULL,true,NULL,60 UNION ALL SELECT 'V5','PRIORITY_AFTER_SALES','IDENTITY',NULL,true,NULL,60 UNION ALL SELECT 'V6','PRIORITY_AFTER_SALES','IDENTITY',NULL,true,NULL,60 UNION ALL
  SELECT 'V3','MONTHLY_NEW_ORDER','MONTHLY',1,false,NULL,70 UNION ALL SELECT 'V4','MONTHLY_NEW_ORDER','MONTHLY',1,false,NULL,70 UNION ALL SELECT 'V5','MONTHLY_NEW_ORDER','MONTHLY',2,false,NULL,70 UNION ALL SELECT 'V6','MONTHLY_NEW_ORDER','MONTHLY',3,false,NULL,70 UNION ALL
  SELECT 'V4','MONTHLY_STREAMER','MONTHLY',1,false,NULL,80 UNION ALL SELECT 'V5','MONTHLY_STREAMER','MONTHLY',2,false,NULL,80 UNION ALL SELECT 'V6','MONTHLY_STREAMER','MONTHLY',3,false,NULL,80 UNION ALL
  SELECT 'V3','MONTHLY_EXAMINER','MONTHLY',1,false,NULL,90 UNION ALL SELECT 'V4','MONTHLY_EXAMINER','MONTHLY',2,false,NULL,90 UNION ALL SELECT 'V5','MONTHLY_EXAMINER','MONTHLY',2,false,NULL,90 UNION ALL SELECT 'V6','MONTHLY_EXAMINER','MONTHLY',3,false,NULL,90 UNION ALL
  SELECT 'V3','MONTHLY_EVENT','MONTHLY',1,false,NULL,100 UNION ALL SELECT 'V4','MONTHLY_EVENT','MONTHLY',2,false,NULL,100 UNION ALL SELECT 'V5','MONTHLY_EVENT','MONTHLY',3,false,NULL,100 UNION ALL SELECT 'V6','MONTHLY_EVENT','MONTHLY',NULL,true,NULL,100 UNION ALL
  SELECT 'V3','VIDEO_EDITING','UPGRADE_ONCE',1,false,NULL,110 UNION ALL SELECT 'V4','VIDEO_EDITING','UPGRADE_ONCE',2,false,NULL,110 UNION ALL SELECT 'V5','VIDEO_EDITING','UPGRADE_ONCE',3,false,NULL,110 UNION ALL SELECT 'V6','VIDEO_EDITING','UPGRADE_ONCE',5,false,NULL,110 UNION ALL
  SELECT 'V2','FREE_RUN','UPGRADE_ONCE',1,false,NULL,120 UNION ALL SELECT 'V3','FREE_RUN','UPGRADE_ONCE',3,false,NULL,120 UNION ALL SELECT 'V4','FREE_RUN','UPGRADE_ONCE',6,false,NULL,120 UNION ALL SELECT 'V5','FREE_RUN','UPGRADE_ONCE',9,false,NULL,120 UNION ALL SELECT 'V6','FREE_RUN','UPGRADE_ONCE',12,false,NULL,120 UNION ALL
  SELECT 'V2','FREE_AW_AMMO','UPGRADE_ONCE',20,false,NULL,130 UNION ALL SELECT 'V3','FREE_AW_AMMO','UPGRADE_ONCE',30,false,NULL,130 UNION ALL SELECT 'V4','FREE_AW_AMMO','UPGRADE_ONCE',50,false,NULL,130 UNION ALL SELECT 'V5','FREE_AW_AMMO','UPGRADE_ONCE',80,false,NULL,130 UNION ALL SELECT 'V6','FREE_AW_AMMO','UPGRADE_ONCE',120,false,NULL,130
) x
JOIN `member_level_configs` l ON l.code=x.levelCode
JOIN `member_benefits` b ON b.code=x.benefitCode;

INSERT INTO `member_recharge_plans` (`title`,`amount`,`bonusAmount`,`giftPoints`,`giftGrowthValue`,`sortOrder`,`enabled`,`createdAt`,`updatedAt`)
SELECT '会员预存3000',3000,150,0,0,10,true,NOW(3),NOW(3) WHERE NOT EXISTS (SELECT 1 FROM `member_recharge_plans` WHERE `amount`=3000 AND `bonusAmount`=150);
INSERT INTO `member_recharge_plans` (`title`,`amount`,`bonusAmount`,`giftPoints`,`giftGrowthValue`,`sortOrder`,`enabled`,`createdAt`,`updatedAt`)
SELECT '会员预存6000',6000,360,0,0,20,true,NOW(3),NOW(3) WHERE NOT EXISTS (SELECT 1 FROM `member_recharge_plans` WHERE `amount`=6000 AND `bonusAmount`=360);
INSERT INTO `member_recharge_plans` (`title`,`amount`,`bonusAmount`,`giftPoints`,`giftGrowthValue`,`sortOrder`,`enabled`,`createdAt`,`updatedAt`)
SELECT '会员预存10000',10000,700,0,0,30,true,NOW(3),NOW(3) WHERE NOT EXISTS (SELECT 1 FROM `member_recharge_plans` WHERE `amount`=10000 AND `bonusAmount`=700);
INSERT INTO `member_recharge_plans` (`title`,`amount`,`bonusAmount`,`giftPoints`,`giftGrowthValue`,`sortOrder`,`enabled`,`createdAt`,`updatedAt`)
SELECT '会员预存30000',30000,2400,0,0,40,true,NOW(3),NOW(3) WHERE NOT EXISTS (SELECT 1 FROM `member_recharge_plans` WHERE `amount`=30000 AND `bonusAmount`=2400);
INSERT INTO `member_recharge_plans` (`title`,`amount`,`bonusAmount`,`giftPoints`,`giftGrowthValue`,`sortOrder`,`enabled`,`createdAt`,`updatedAt`)
SELECT '会员预存50000',50000,4500,0,0,50,true,NOW(3),NOW(3) WHERE NOT EXISTS (SELECT 1 FROM `member_recharge_plans` WHERE `amount`=50000 AND `bonusAmount`=4500);
INSERT INTO `member_recharge_plans` (`title`,`amount`,`bonusAmount`,`giftPoints`,`giftGrowthValue`,`sortOrder`,`enabled`,`createdAt`,`updatedAt`)
SELECT '会员预存80000',80000,8000,0,0,60,true,NOW(3),NOW(3) WHERE NOT EXISTS (SELECT 1 FROM `member_recharge_plans` WHERE `amount`=80000 AND `bonusAmount`=8000);

-- 统一修复历史累计消费：包含游戏名片已关联的订单，排除赠送单，并冲减成功/待线下执行退款。
UPDATE `member_profiles` mp
LEFT JOIN (
  SELECT paid.`customerUserId`, ROUND(SUM(GREATEST(0, paid.baseAmount - COALESCE(refunded.refundAmount, 0))), 2) totalConsumeAmount
  FROM (
    SELECT o.id, o.`customerUserId`,
      CASE
        WHEN o.`isTestPayment` = true AND COALESCE(o.`finalPayableAmount`, 0) > 0 THEN o.`finalPayableAmount`
        ELSE COALESCE(o.`paidAmount`, 0)
      END baseAmount
    FROM `Order` o
    WHERE o.`customerUserId` IS NOT NULL
      AND o.`isGifted` = false
      AND (o.`isPaid` = true OR o.`payStatus` = 'SUCCESS')
  ) paid
  LEFT JOIN (
    SELECT r.`orderId`, SUM(r.amount) refundAmount
    FROM `order_refunds` r
    WHERE r.status IN ('SUCCESS', 'MANUAL_REQUIRED')
    GROUP BY r.`orderId`
  ) refunded ON refunded.`orderId` = paid.id
  GROUP BY paid.`customerUserId`
) totals ON totals.`customerUserId` = mp.`userId`
SET mp.`totalConsumeAmount` = COALESCE(totals.totalConsumeAmount, 0);
