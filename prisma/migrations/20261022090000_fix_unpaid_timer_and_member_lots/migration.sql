START TRANSACTION;

-- 会员储值历史数据：钱包余额已经存在，但旧充值/退款链路未完整生成资金批次。
-- 仅补批次台账，不改变会员钱包余额；后续订单仍按批次扣减并可追溯。
INSERT INTO `member_balance_lots` (
  `userId`, `rechargeOrderId`, `sourceType`,
  `principalInitial`, `principalRemaining`, `bonusInitial`, `bonusRemaining`,
  `status`, `createdAt`, `updatedAt`
)
SELECT
  gaps.`userId`, NULL, 'LEGACY_RECONCILIATION',
  gaps.`gapAmount`, gaps.`gapAmount`, 0.00, 0.00,
  'ACTIVE', NOW(3), NOW(3)
FROM (
  SELECT
    wa.`userId`,
    ROUND(
      wa.`availableBalance` - COALESCE(SUM(
        CASE WHEN mbl.`status` = 'ACTIVE'
          THEN mbl.`principalRemaining` + mbl.`bonusRemaining`
          ELSE 0 END
      ), 0),
      2
    ) AS `gapAmount`
  FROM `wallet_accounts` wa
  INNER JOIN `member_profiles` mp ON mp.`userId` = wa.`userId`
  LEFT JOIN `member_balance_lots` mbl ON mbl.`userId` = wa.`userId`
  GROUP BY wa.`userId`, wa.`availableBalance`
  HAVING `gapAmount` > 0
) gaps;

-- 派单、接单和存单阶段不再计算48小时未收款责任期。
UPDATE `Order`
SET `unpaidSince` = NULL,
    `unpaidLastReminderAt` = NULL
WHERE `isPaid` = 0
  AND `status` NOT IN ('COMPLETED_PENDING_CONFIRM', 'COMPLETED');

-- 已结单待确认/已结单的历史未收款订单，以实际结单时间作为责任期起点。
UPDATE `Order` o
LEFT JOIN (
  SELECT `orderId`, MAX(`completedAt`) AS `completedAt`
  FROM `OrderDispatch`
  WHERE `completedAt` IS NOT NULL
  GROUP BY `orderId`
) completed ON completed.`orderId` = o.`id`
SET o.`unpaidSince` = COALESCE(completed.`completedAt`, o.`updatedAt`),
    o.`unpaidLastReminderAt` = NULL
WHERE o.`isPaid` = 0
  AND o.`isGifted` = 0
  AND o.`status` IN ('COMPLETED_PENDING_CONFIRM', 'COMPLETED');

-- 修复已确认的历史误扣：订单 V01HS97U4S4E5 在存单状态即满48小时扣除了派单客服余额。
-- 返还客服余额并保留独立冲正流水，撤销错误的责任代付结果，使订单恢复为未收款存单。
UPDATE `wallet_accounts` wa
JOIN `Order` o ON o.`unpaidResponsibleUserId` = wa.`userId`
JOIN `order_payments` op ON op.`id` = o.`latestPaymentId`
LEFT JOIN `wallet_transactions` reversal
  ON reversal.`sourceType` = 'ORDER_UNPAID_CS_LIABILITY_REVERSAL'
 AND reversal.`sourceId` = o.`id`
SET wa.`availableBalance` = wa.`availableBalance` + o.`unpaidAutoDeductedAmount`
WHERE o.`id` = 13406
  AND o.`autoSerial` = 'V01HS97U4S4E5'
  AND o.`status` = 'ARCHIVED'
  AND op.`paymentNo` = 'CSB-13406-1792483200061'
  AND o.`unpaidAutoDeductedAmount` > 0
  AND reversal.`id` IS NULL;

INSERT INTO `wallet_transactions` (
  `userId`, `direction`, `bizType`, `amount`, `status`,
  `sourceType`, `sourceId`, `orderId`, `availableAfter`, `frozenAfter`, `remark`, `createdAt`
)
SELECT
  o.`unpaidResponsibleUserId`, 'IN', 'ORDER_UNPAID_CS_LIABILITY_REVERSAL',
  o.`unpaidAutoDeductedAmount`, 'AVAILABLE',
  'ORDER_UNPAID_CS_LIABILITY_REVERSAL', o.`id`, o.`id`,
  wa.`availableBalance`, wa.`frozenBalance`,
  '历史修复：订单在存单阶段错误启动48小时计时，退回客服责任代扣', NOW(3)
FROM `Order` o
JOIN `wallet_accounts` wa ON wa.`userId` = o.`unpaidResponsibleUserId`
JOIN `order_payments` op ON op.`id` = o.`latestPaymentId`
LEFT JOIN `wallet_transactions` reversal
  ON reversal.`sourceType` = 'ORDER_UNPAID_CS_LIABILITY_REVERSAL'
 AND reversal.`sourceId` = o.`id`
WHERE o.`id` = 13406
  AND o.`autoSerial` = 'V01HS97U4S4E5'
  AND o.`status` = 'ARCHIVED'
  AND op.`paymentNo` = 'CSB-13406-1792483200061'
  AND o.`unpaidAutoDeductedAmount` > 0
  AND reversal.`id` IS NULL;

DELETE FROM `order_receipts`
WHERE `receiptKey` = 'CS_LIABILITY:13406'
  AND `orderId` = 13406;

UPDATE `order_payments`
SET `status` = 'CLOSED'
WHERE `id` = 6700
  AND `orderId` = 13406
  AND `paymentNo` = 'CSB-13406-1792483200061'
  AND `channel` = 'CUSTOMER_SERVICE_BALANCE';

UPDATE `Order`
SET `isPaid` = 0,
    `payStatus` = 'PENDING',
    `paymentTime` = NULL,
    `latestPaymentId` = NULL,
    `unpaidSince` = NULL,
    `unpaidLastReminderAt` = NULL,
    `unpaidAutoDeductedAt` = NULL,
    `unpaidAutoDeductedAmount` = 0.00
WHERE `id` = 13406
  AND `autoSerial` = 'V01HS97U4S4E5'
  AND `status` = 'ARCHIVED'
  AND `latestPaymentId` = 6700;

COMMIT;
