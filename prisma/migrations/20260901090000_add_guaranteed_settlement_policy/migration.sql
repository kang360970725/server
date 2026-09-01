ALTER TABLE `GameProject`
  ADD COLUMN `guaranteedSettlementMode` VARCHAR(32) NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN `minimumFinalProgressWan` DOUBLE NULL;

-- 仅用于把当前存量商品切到已确认规则；后续调价/新增商品均通过项目配置维护，不再依赖价格判断。
UPDATE `GameProject`
SET `guaranteedSettlementMode` = 'FINAL_ROUND_TAKES_ALL', `minimumFinalProgressWan` = NULL
WHERE `billingMode` = 'GUARANTEED' AND `type` = 'EXPERIENCE' AND ABS(`price` - 108) < 0.001;

UPDATE `GameProject`
SET `guaranteedSettlementMode` = 'STANDARD', `minimumFinalProgressWan` = 600
WHERE `billingMode` = 'GUARANTEED' AND `type` = 'EXPERIENCE' AND ABS(`price` - 199) < 0.001;

UPDATE `GameProject`
SET `minimumFinalProgressWan` = 800
WHERE `billingMode` = 'GUARANTEED' AND `type` <> 'EXPERIENCE';

-- 将上线时规则固化到存量订单快照；此后商品调价或改规则不会追溯影响这些订单。
UPDATE `Order` o
JOIN `GameProject` p ON p.`id` = o.`projectId`
SET o.`projectSnapshot` = JSON_SET(
  COALESCE(o.`projectSnapshot`, JSON_OBJECT()),
  '$.guaranteedSettlementMode', p.`guaranteedSettlementMode`
);

UPDATE `Order` o
JOIN `GameProject` p ON p.`id` = o.`projectId`
SET o.`projectSnapshot` = JSON_SET(
  o.`projectSnapshot`, '$.minimumFinalProgressWan', JSON_EXTRACT(CAST(p.`minimumFinalProgressWan` AS CHAR), '$')
)
WHERE p.`minimumFinalProgressWan` IS NOT NULL;

UPDATE `Order` o
JOIN `GameProject` p ON p.`id` = o.`projectId`
SET o.`projectSnapshot` = JSON_SET(
  o.`projectSnapshot`, '$.minimumFinalProgressWan', JSON_EXTRACT('null', '$')
)
WHERE p.`minimumFinalProgressWan` IS NULL;
