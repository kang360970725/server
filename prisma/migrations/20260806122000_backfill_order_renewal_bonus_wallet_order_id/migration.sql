UPDATE `wallet_transactions` wt
JOIN `order_renewal_bonuses` orb
  ON wt.`id` = orb.`walletTransactionId`
LEFT JOIN `order_renewal_groups` org
  ON org.`id` = orb.`renewalGroupId`
SET
  wt.`orderId` = orb.`orderId`,
  wt.`dispatchId` = COALESCE(wt.`dispatchId`, org.`dispatchId`)
WHERE wt.`bizType` = 'ORDER_RENEWAL_BONUS'
  AND wt.`sourceType` = 'ORDER_RENEWAL_BONUS'
  AND (
    wt.`orderId` IS NULL
    OR wt.`dispatchId` IS NULL
  );
