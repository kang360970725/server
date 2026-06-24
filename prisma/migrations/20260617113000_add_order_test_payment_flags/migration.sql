ALTER TABLE `Order`
  ADD COLUMN `isTestPayment` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `order_payments`
  ADD COLUMN `isTestPayment` BOOLEAN NOT NULL DEFAULT false;
