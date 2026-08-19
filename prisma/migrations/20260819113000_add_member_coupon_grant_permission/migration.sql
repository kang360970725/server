INSERT INTO `Permission` (`key`, `name`, `module`, `type`, `parentId`, `createdAt`, `updatedAt`)
SELECT 'users:member:coupon-grant:button', '会员手动发券', 'users', 'BUTTON', p.`id`, NOW(3), NOW(3)
FROM `Permission` p
WHERE p.`key` = 'users:member:page'
  AND NOT EXISTS (
    SELECT 1 FROM `Permission` x WHERE x.`key` = 'users:member:coupon-grant:button'
  );

UPDATE `Permission` child
JOIN `Permission` parent ON parent.`key` = 'users:member:page'
SET child.`parentId` = parent.`id`,
    child.`name` = '会员手动发券',
    child.`module` = 'users',
    child.`type` = 'BUTTON',
    child.`updatedAt` = NOW(3)
WHERE child.`key` = 'users:member:coupon-grant:button';
