-- 打手新增/编辑安全调整配套数据：
-- 1. 确保默认陪玩角色存在；
-- 2. 对已有角色授权进行修正：若拥有按钮权限，自动补齐其父级页面权限，避免只放按钮后页面入口丢失。

INSERT INTO `Role` (`id`, `name`, `description`, `createdAt`, `updatedAt`)
SELECT 3, '陪玩', '俱乐部陪玩', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM `Role` WHERE `id` = 3)
  AND NOT EXISTS (SELECT 1 FROM `Role` WHERE `name` = '陪玩');

INSERT INTO `Role` (`name`, `description`, `createdAt`, `updatedAt`)
SELECT '陪玩', '俱乐部陪玩', NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM `Role` WHERE `name` = '陪玩');

UPDATE `Role`
SET `description` = '俱乐部陪玩',
    `updatedAt` = NOW()
WHERE `id` = 3
  AND `name` = '陪玩';

INSERT IGNORE INTO `_PermissionToRole` (`A`, `B`)
SELECT parent.`id`, ptr.`B`
FROM `_PermissionToRole` ptr
JOIN `Permission` child ON child.`id` = ptr.`A`
JOIN `Permission` parent ON parent.`id` = child.`parentId`
WHERE child.`key` NOT LIKE 'menu:%'
  AND parent.`key` NOT LIKE 'menu:%';
