ALTER TABLE `orders`
  ADD COLUMN `customerIdentifierType` VARCHAR(20) NULL,
  ADD COLUMN `customerOriginalIdentifier` TEXT NULL;

UPDATE `orders`
SET `customerIdentifierType` = 'GAME_ID',
    `customerOriginalIdentifier` = `customerGameId`
WHERE `customerIdentifierType` IS NULL;

CREATE INDEX `idx_order_customer_identifier_type` ON `orders`(`customerIdentifierType`);
