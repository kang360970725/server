ALTER TABLE `order_renewal_bonuses`
  DROP INDEX `uniq_order_renewal_bonus_group_user`,
  ADD INDEX `idx_order_renewal_bonus_group_user` (`renewalGroupId`, `userId`);
