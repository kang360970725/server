-- Add automatic payout state fields for wallet withdrawal requests.
ALTER TABLE `wallet_withdrawal_requests`
  ADD COLUMN `transferStatus` ENUM('NOT_STARTED','PROCESSING','WAIT_USER_CONFIRM','SUCCESS','FAILED','CANCELLED','MANUAL_FALLBACK') NOT NULL DEFAULT 'NOT_STARTED' AFTER `channel`,
  ADD COLUMN `transferStartedAt` DATETIME(3) NULL AFTER `channelTradeNo`,
  ADD COLUMN `transferFinishedAt` DATETIME(3) NULL AFTER `transferStartedAt`,
  ADD COLUMN `manualFallbackAt` DATETIME(3) NULL AFTER `transferFinishedAt`,
  ADD COLUMN `manualFallbackBy` INTEGER NULL AFTER `manualFallbackAt`;

CREATE INDEX `wallet_withdrawal_requests_channel_transferStatus_idx`
  ON `wallet_withdrawal_requests`(`channel`, `transferStatus`);

-- Backfill historical terminal records for clearer reporting.
UPDATE `wallet_withdrawal_requests`
SET `transferStatus` = 'SUCCESS',
    `transferFinishedAt` = COALESCE(`reviewedAt`, `updatedAt`)
WHERE `status` = 'PAID';

UPDATE `wallet_withdrawal_requests`
SET `transferStatus` = 'FAILED',
    `transferFinishedAt` = COALESCE(`reviewedAt`, `updatedAt`)
WHERE `status` = 'FAILED';

UPDATE `wallet_withdrawal_requests`
SET `transferStatus` = 'CANCELLED',
    `transferFinishedAt` = COALESCE(`reviewedAt`, `updatedAt`)
WHERE `status` IN ('REJECTED', 'CANCELED');

-- Seed automatic withdrawal configuration. Idempotent for production redeploys.
INSERT INTO `system_configs` (`key`, `value`, `valueType`, `remark`, `enabled`, `createdAt`, `updatedAt`)
VALUES
  ('withdraw_auto_transfer_enabled', 'false', 'BOOLEAN', '提现自动打款总开关', true, NOW(3), NOW(3)),
  ('withdraw_wechat_transfer_enabled', 'false', 'BOOLEAN', '微信商家转账通道开关', true, NOW(3), NOW(3)),
  ('withdraw_wechat_transfer_mock', 'false', 'BOOLEAN', '微信商家转账测试模式：不请求微信，直接模拟受理成功', true, NOW(3), NOW(3)),
  ('withdraw_auto_single_limit', '2000', 'NUMBER', '提现自动打款单笔上限', true, NOW(3), NOW(3)),
  ('withdraw_auto_first_limit', '1000', 'NUMBER', '新人首次提现自动打款上限', true, NOW(3), NOW(3)),
  ('withdraw_auto_user_day_limit', '5000', 'NUMBER', '单人每日自动打款上限', true, NOW(3), NOW(3)),
  ('withdraw_auto_user_month_limit', '15000', 'NUMBER', '单人每月自动打款上限', true, NOW(3), NOW(3)),
  ('withdraw_auto_platform_day_limit', '50000', 'NUMBER', '平台每日自动打款总额上限', true, NOW(3), NOW(3)),
  ('withdraw_auto_eligibility', '{\n  "mode": "WHITELIST",\n  "userIds": [],\n  "staffRuleGroups": [],\n  "allowActiveStaffOnly": true,\n  "requireWechatBinding": true,\n  "remark": "mode=ALL 表示符合风控即允许；mode=WHITELIST 表示仅 userIds 或 staffRuleGroups 命中者允许。"\n}', 'JSON', '小额自动打款资格配置', true, NOW(3), NOW(3)),
  ('wechat_transfer_scene_id', '', 'STRING', '微信商家转账场景ID', true, NOW(3), NOW(3)),
  ('wechat_transfer_notify_url', '', 'STRING', '微信商家转账回调地址', true, NOW(3), NOW(3)),
  ('wechat_transfer_appid', '', 'STRING', '微信商家转账收款 openid 所属 AppID；H5 绑定时通常填公众号 AppID，空则回退小程序 AppID', true, NOW(3), NOW(3)),
  ('wechat_transfer_appsecret', '', 'STRING', '微信商家转账 AppID 对应 AppSecret；H5 微信网页授权绑定使用', true, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  `remark` = VALUES(`remark`),
  `updatedAt` = NOW(3);
