ALTER TABLE `orders`
  ADD COLUMN `customerUserId` INTEGER NULL,
  ADD COLUMN `orderSource` VARCHAR(40) NULL,
  MODIFY `dispatcherId` INTEGER NULL;

CREATE INDEX `Order_customerUserId_idx` ON `orders`(`customerUserId`);
CREATE INDEX `Order_orderSource_idx` ON `orders`(`orderSource`);

ALTER TABLE `orders`
  ADD CONSTRAINT `orders_customerUserId_fkey`
  FOREIGN KEY (`customerUserId`) REFERENCES `users`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE `orders`
SET `orderSource` = 'CUSTOMER_SERVICE_MANUAL'
WHERE `orderSource` IS NULL OR TRIM(`orderSource`) = '';
