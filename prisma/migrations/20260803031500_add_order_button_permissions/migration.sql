INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`) VALUES
('orders:workbench:create:button', '客服工作台创建订单', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:list:create:button', '订单列表创建订单', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:list:delete:button', '订单列表删除订单', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:receipt:button', '订单小票', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:mark-paid:button', '确认收款', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:refund:button', '订单退款', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:edit:button', '编辑订单', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:dispatch:button', '派单/改派', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:update-paid:button', '修改实付/补收', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:confirm-complete:button', '确认结单', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:admin-accept:button', '客服代接单', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:archive:button', '客服存单', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:complete:button', '客服结单', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:rollback-accepted:button', '回退到接单中', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:rollback-archived:button', '回退到存单', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:update-participants:button', '更新参与者', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:settlement-adjust:button', '调整结算收益', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:archived-progress-fix:button', '修复存单进度', 'orders', 'BUTTON', NULL, NOW(), NOW()),
('orders:detail:recalculate-settlements:button', '重算订单结算', 'orders', 'BUTTON', NULL, NOW(), NOW())
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `module` = VALUES(`module`),
  `type` = VALUES(`type`),
  `updatedAt` = NOW();

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'orders:workbench:page'
SET child.`parentId` = parent.`id`, child.`updatedAt` = NOW()
WHERE child.`key` IN ('orders:workbench:create:button');

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'orders:list:page'
SET child.`parentId` = parent.`id`, child.`updatedAt` = NOW()
WHERE child.`key` IN ('orders:list:create:button', 'orders:list:delete:button');

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'orders:detail:page'
SET child.`parentId` = parent.`id`, child.`updatedAt` = NOW()
WHERE child.`key` IN (
  'orders:detail:receipt:button',
  'orders:detail:mark-paid:button',
  'orders:detail:refund:button',
  'orders:detail:edit:button',
  'orders:detail:dispatch:button',
  'orders:detail:update-paid:button',
  'orders:detail:confirm-complete:button',
  'orders:detail:admin-accept:button',
  'orders:detail:archive:button',
  'orders:detail:complete:button',
  'orders:detail:rollback-accepted:button',
  'orders:detail:rollback-archived:button',
  'orders:detail:update-participants:button',
  'orders:detail:settlement-adjust:button',
  'orders:detail:archived-progress-fix:button',
  'orders:detail:recalculate-settlements:button'
);
