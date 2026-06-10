ALTER TABLE `Order`
  ADD COLUMN `initialDispatcherId` INTEGER NULL;

UPDATE `Order`
SET `initialDispatcherId` = `dispatcherId`
WHERE `initialDispatcherId` IS NULL
  AND `dispatcherId` IS NOT NULL;

ALTER TABLE `Order`
  ADD CONSTRAINT `Order_initialDispatcherId_fkey`
  FOREIGN KEY (`initialDispatcherId`) REFERENCES `users`(`id`)
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX `Order_initialDispatcherId_idx` ON `Order`(`initialDispatcherId`);
