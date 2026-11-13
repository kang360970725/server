ALTER TABLE `equipment_rental_bills`
  ADD COLUMN `billingSlot` INTEGER NOT NULL DEFAULT 0;

-- The old billing month was the due month, and its period ended 1 ms before the due date.
UPDATE `equipment_rental_bills`
SET `billingSlot` = -1
WHERE DATE_FORMAT(`dueAt`, '%Y-%m') = `billMonth`
  AND TIMESTAMPDIFF(MICROSECOND, `periodEnd`, `dueAt`) = 1000;

ALTER TABLE `equipment_rental_bills`
  ADD UNIQUE INDEX `uniq_equipment_rental_contract_month_slot` (`contractId`, `billMonth`, `billingSlot`),
  DROP INDEX `uniq_equipment_rental_contract_month`;
