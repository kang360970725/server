INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`) VALUES
('users:member:create:button', '新增会员', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:member:edit:button', '编辑会员资料', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:member:delete:button', '删除会员', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:member:recharge:button', '会员手动充值', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:member:growth-adjust:button', '调整会员成长值', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:member:game-card:button', '维护会员游戏名片', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:staff:create:button', '新增打手', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:staff:edit:button', '编辑打手资料', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:staff:assign-role:button', '打手分配角色', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:staff:change-level:button', '员工升降级', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:staff:reset-password:button', '重置打手密码', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:staff:delete:button', '删除打手', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:staff:exit:button', '员工退店', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:staff:clear:button', '员工清退', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:staff:wallet-stats:button', '员工资金统计', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:staff:withdraw-qr-reset:button', '重置收款码', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:internal:create:button', '新增后台人员', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:internal:edit:button', '编辑后台人员资料', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:internal:assign-role:button', '后台人员分配角色', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:internal:reset-password:button', '重置后台人员密码', 'users', 'BUTTON', NULL, NOW(), NOW()),
('users:internal:delete:button', '删除后台人员', 'users', 'BUTTON', NULL, NOW(), NOW())
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `module` = VALUES(`module`),
  `type` = VALUES(`type`),
  `updatedAt` = NOW();

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'users:member:page'
SET child.`parentId` = parent.`id`, child.`updatedAt` = NOW()
WHERE child.`key` IN (
  'users:member:create:button',
  'users:member:edit:button',
  'users:member:delete:button',
  'users:member:recharge:button',
  'users:member:growth-adjust:button',
  'users:member:game-card:button'
);

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'users:staff:page'
SET child.`parentId` = parent.`id`, child.`updatedAt` = NOW()
WHERE child.`key` IN (
  'users:staff:create:button',
  'users:staff:edit:button',
  'users:staff:assign-role:button',
  'users:staff:change-level:button',
  'users:staff:reset-password:button',
  'users:staff:delete:button',
  'users:staff:exit:button',
  'users:staff:clear:button',
  'users:staff:wallet-stats:button',
  'users:staff:withdraw-qr-reset:button'
);

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'users:internal:page'
SET child.`parentId` = parent.`id`, child.`updatedAt` = NOW()
WHERE child.`key` IN (
  'users:internal:create:button',
  'users:internal:edit:button',
  'users:internal:assign-role:button',
  'users:internal:reset-password:button',
  'users:internal:delete:button'
);
