-- AlterTable
ALTER TABLE `wallet_accounts` MODIFY `availableBalance` DECIMAL(12, 2) NOT NULL DEFAULT 0.0,
    MODIFY `frozenBalance` DECIMAL(12, 2) NOT NULL DEFAULT 0.0,
    MODIFY `earningFrozenBalance` DECIMAL(12, 2) NOT NULL DEFAULT 0.0,
    MODIFY `withdrawFrozenBalance` DECIMAL(12, 2) NOT NULL DEFAULT 0.0;

-- AlterTable
ALTER TABLE `wallet_transactions` MODIFY `bizType` ENUM('SETTLEMENT_EARNING', 'SETTLEMENT_EARNING_BASE', 'SETTLEMENT_EARNING_CARRY', 'SETTLEMENT_BOMB_LOSS', 'SETTLEMENT_EARNING_CS', 'ORDER_RENEWAL_BONUS', 'ORDER_RENEWAL_BONUS_REVERSAL', 'RELEASE_FROZEN', 'REFUND_REVERSAL', 'WITHDRAW_RESERVE', 'WITHDRAW_RELEASE', 'WITHDRAW_PAYOUT', 'DEPOSIT_REFUND', 'DEPOSIT_ADD', 'DEPOSIT_DEDUCT', 'OFFLINE_FEE_PAYMENT', 'EQUIPMENT_RENTAL_FEE', 'RENTAL_ORDER_PREPAY', 'RENTAL_ORDER_DEPOSIT', 'RENTAL_ORDER_REFUND', 'RENTAL_ORDER_EXCESS_CHARGE', 'RENTAL_ORDER_VOID_REFUND', 'SETTLEMENT_REVERSAL', 'SETTLEMENT_RECALC', 'MEMBER_RECHARGE', 'MEMBER_RECHARGE_BONUS', 'MEMBER_ORDER_CONSUME', 'MEMBER_RECHARGE_REFUND', 'STAFF_EXIT_RELEASE', 'STAFF_EXIT_CLEAR') NOT NULL;

-- CreateTable
CREATE TABLE `rental_orders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `serialNo` VARCHAR(12) NOT NULL,
    `staffUserId` INTEGER NOT NULL,
    `staffNameSnapshot` VARCHAR(100) NOT NULL,
    `accountSourceId` INTEGER NULL,
    `accountSourceNo` VARCHAR(100) NOT NULL,
    `sourceChannel` VARCHAR(24) NOT NULL DEFAULT 'ADMIN',
    `prepaidAmount` DECIMAL(12, 2) NOT NULL,
    `depositAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `startDate` DATE NOT NULL,
    `forcedSettlementDate` DATE NOT NULL,
    `status` ENUM('RUNNING', 'SETTLED', 'VOIDED') NOT NULL DEFAULT 'RUNNING',
    `noRefundDifference` BOOLEAN NOT NULL DEFAULT true,
    `refundDifferenceAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `refundDifferenceRemark` TEXT NULL,
    `lossAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `lossDetail` TEXT NULL,
    `hasAbnormalCompensation` BOOLEAN NOT NULL DEFAULT false,
    `abnormalCompensationAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `abnormalCompensationRemark` TEXT NULL,
    `ownerSettlementAmount` DECIMAL(12, 2) NULL,
    `actualAmount` DECIMAL(12, 2) NULL,
    `settlementNetRefund` DECIMAL(12, 2) NULL,
    `calculationSnapshot` JSON NULL,
    `createdBy` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `settledBy` INTEGER NULL,
    `settledAt` DATETIME(3) NULL,
    `voidedBy` INTEGER NULL,
    `voidedAt` DATETIME(3) NULL,
    `voidReason` TEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `rental_orders_serialNo_key`(`serialNo`),
    INDEX `rental_orders_staffUserId_createdAt_idx`(`staffUserId`, `createdAt`),
    INDEX `rental_orders_status_forcedSettlementDate_idx`(`status`, `forcedSettlementDate`),
    INDEX `rental_orders_createdAt_idx`(`createdAt`),
    INDEX `rental_orders_settledAt_idx`(`settledAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
