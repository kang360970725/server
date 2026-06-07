ALTER TABLE `Order`
  ADD COLUMN `settlementBaseAmount` DOUBLE NOT NULL DEFAULT 0;

ALTER TABLE `OrderFinanceRecord`
  ADD COLUMN `settlementBaseAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0;
