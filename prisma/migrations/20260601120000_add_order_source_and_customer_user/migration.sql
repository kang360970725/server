ALTER TABLE `Order`
  ADD COLUMN `customerUserId` INTEGER NULL,
  ADD COLUMN `orderSource` VARCHAR(40) NULL,
  MODIFY `dispatcherId` INTEGER NULL;

CREATE INDEX `Order_customerUserId_idx` ON `Order`(`customerUserId`);
CREATE INDEX `Order_orderSource_idx` ON `Order`(`orderSource`);

ALTER TABLE `Order`
  ADD CONSTRAINT `orders_customerUserId_fkey`
  FOREIGN KEY (`customerUserId`) REFERENCES `users`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE `Order`
SET `orderSource` = 'CUSTOMER_SERVICE_MANUAL'
WHERE `orderSource` IS NULL OR TRIM(`orderSource`) = '';
