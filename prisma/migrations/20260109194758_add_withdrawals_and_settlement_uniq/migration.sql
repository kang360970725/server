/*
  Warnings:

  - A unique constraint covering the columns `[dispatchId,userId,settlementType]` on the table `OrderSettlement` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `settlementBatchId` to the `OrderSettlement` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `OrderDispatch` MODIFY `status` ENUM('WAIT_ASSIGN', 'WAIT_ACCEPT', 'ACCEPTED', 'SETTLING', 'ARCHIVED', 'COMPLETED') NOT NULL DEFAULT 'WAIT_ASSIGN';

-- AlterTable
-- ✅ 分两步加 settlementBatchId：
-- 1) 先加为可空（NULLABLE），让迁移可执行（因为表里有历史数据）
-- 2) 回填历史数据（给每条历史 settlement 一个稳定批次号）
-- 3) 再改为 NOT NULL（满足新代码的约束）

ALTER TABLE `OrderSettlement`
    ADD COLUMN `settlementBatchId` VARCHAR(191) NULL;

-- ✅ 回填历史数据
-- 说明：
-- - 旧数据没有“批次号”概念，这里用一个可追溯的规则填充
-- - 我推荐：按 dispatchId 维度生成批次（同一 dispatch 的历史 settlement 归为同一批次）
-- - 这样后续排查也更直观（一个 dispatch 对应一个 batch）

UPDATE `OrderSettlement`
SET `settlementBatchId` = CONCAT('legacy_dispatch_', `dispatchId`)
WHERE `settlementBatchId` IS NULL;

-- ✅ 再把字段改为必填
ALTER TABLE `OrderSettlement`
    MODIFY COLUMN `settlementBatchId` VARCHAR(191) NOT NULL;


-- AlterTable
ALTER TABLE `wallet_transactions` MODIFY `bizType` ENUM('SETTLEMENT_EARNING', 'RELEASE_FROZEN', 'REFUND_REVERSAL', 'WITHDRAW_RESERVE', 'WITHDRAW_RELEASE', 'WITHDRAW_PAYOUT') NOT NULL;

-- CreateTable
CREATE TABLE `wallet_withdrawal_requests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `amount` DOUBLE NOT NULL,
    `status` ENUM('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PAYING', 'PAID', 'FAILED', 'CANCELED') NOT NULL DEFAULT 'PENDING_REVIEW',
    `channel` ENUM('WECHAT', 'MANUAL') NOT NULL DEFAULT 'MANUAL',
    `idempotencyKey` VARCHAR(64) NOT NULL,
    `requestNo` VARCHAR(32) NOT NULL,
    `remark` VARCHAR(191) NULL,
    `reviewedBy` INTEGER NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewRemark` VARCHAR(191) NULL,
    `reserveTxId` INTEGER NOT NULL,
    `payoutTxId` INTEGER NULL,
    `outTradeNo` VARCHAR(64) NULL,
    `channelTradeNo` VARCHAR(64) NULL,
    `callbackRaw` TEXT NULL,
    `failReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `wallet_withdrawal_requests_requestNo_key`(`requestNo`),
    UNIQUE INDEX `wallet_withdrawal_requests_reserveTxId_key`(`reserveTxId`),
    UNIQUE INDEX `wallet_withdrawal_requests_payoutTxId_key`(`payoutTxId`),
    INDEX `wallet_withdrawal_requests_userId_status_createdAt_idx`(`userId`, `status`, `createdAt`),
    INDEX `wallet_withdrawal_requests_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `uniq_withdraw_user_idempotency`(`userId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `OrderSettlement_settlementBatchId_idx` ON `OrderSettlement`(`settlementBatchId`);

-- CreateIndex
CREATE UNIQUE INDEX `uniq_settlement_dispatch_user_type` ON `OrderSettlement`(`dispatchId`, `userId`, `settlementType`);

-- AddForeignKey
ALTER TABLE `wallet_withdrawal_requests` ADD CONSTRAINT `wallet_withdrawal_requests_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_withdrawal_requests` ADD CONSTRAINT `wallet_withdrawal_requests_reserveTxId_fkey` FOREIGN KEY (`reserveTxId`) REFERENCES `wallet_transactions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallet_withdrawal_requests` ADD CONSTRAINT `wallet_withdrawal_requests_payoutTxId_fkey` FOREIGN KEY (`payoutTxId`) REFERENCES `wallet_transactions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
