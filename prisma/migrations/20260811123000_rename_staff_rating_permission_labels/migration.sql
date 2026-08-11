UPDATE `Permission`
SET `name` = '服务者评级', `updatedAt` = NOW()
WHERE `key` IN ('menu:staff-ratings', 'staff-ratings:page');
