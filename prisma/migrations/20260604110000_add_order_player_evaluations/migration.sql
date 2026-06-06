-- 打手结单评价/打赏/售后责任记录
CREATE TABLE `order_player_evaluations` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `orderId` INT NOT NULL,
  `dispatchId` INT NOT NULL,
  `playerUserId` INT NOT NULL,
  `evaluatorId` INT NOT NULL,
  `score` INT NOT NULL,
  `ratingLabel` VARCHAR(20) NOT NULL,
  `afterSaleHandled` BOOLEAN NOT NULL DEFAULT FALSE,
  `afterSaleAction` VARCHAR(40) NULL,
  `responsibleUserIds` JSON NULL,
  `tippedUserIds` JSON NULL,
  `tipPoolAmount` DECIMAL(10,2) NULL,
  `tipAmount` DECIMAL(10,2) NULL,
  `penaltyAmount` DECIMAL(10,2) NULL,
  `maintenanceFeeAmount` DECIMAL(10,2) NULL,
  `reviewRemark` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_order_player_eval_dispatch_player` (`orderId`, `dispatchId`, `playerUserId`),
  KEY `idx_order_player_eval_order_created` (`orderId`, `createdAt`),
  KEY `idx_order_player_eval_player_created` (`playerUserId`, `createdAt`),
  KEY `idx_order_player_eval_evaluator_created` (`evaluatorId`, `createdAt`),
  CONSTRAINT `order_player_evaluations_orderId_fkey`
    FOREIGN KEY (`orderId`) REFERENCES `Order` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `order_player_evaluations_dispatchId_fkey`
    FOREIGN KEY (`dispatchId`) REFERENCES `OrderDispatch` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `order_player_evaluations_playerUserId_fkey`
    FOREIGN KEY (`playerUserId`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `order_player_evaluations_evaluatorId_fkey`
    FOREIGN KEY (`evaluatorId`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
