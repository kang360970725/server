-- AlterTable
ALTER TABLE `rental_orders`
    ADD COLUMN `reconciledBy` INTEGER NULL,
    ADD COLUMN `reconciledAt` DATETIME(3) NULL,
    ADD COLUMN `reconciliationAmount` DECIMAL(12, 2) NULL,
    ADD COLUMN `reconciliationRemark` TEXT NULL;

-- CreateIndex
CREATE INDEX `rental_orders_reconciledAt_idx` ON `rental_orders`(`reconciledAt`);
