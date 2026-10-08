-- 设备租赁费允许同一服务者同时存在多条配置；每条配置每月各生成一张账单。
ALTER TABLE `equipment_rental_bills`
  DROP INDEX `uniq_equipment_rental_user_month`,
  DROP INDEX `idx_equipment_rental_bill_contract_month`,
  ADD UNIQUE INDEX `uniq_equipment_rental_contract_month` (`contractId`, `billMonth`),
  ADD INDEX `idx_equipment_rental_bill_user_month` (`userId`, `billMonth`);
