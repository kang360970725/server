ALTER TABLE `order_renewal_groups`
  ADD COLUMN `attributionType` VARCHAR(24) NOT NULL DEFAULT 'RENEWAL';

CREATE INDEX `idx_order_renewal_group_attr_rank`
  ON `order_renewal_groups`(`attributionType`, `status`, `settledAt`);
