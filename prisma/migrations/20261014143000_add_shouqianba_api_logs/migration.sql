CREATE TABLE `shouqianba_api_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `endpoint` VARCHAR(100) NOT NULL,
    `direction` VARCHAR(16) NOT NULL DEFAULT 'OUTBOUND',
    `clientSn` VARCHAR(32) NULL,
    `providerSn` VARCHAR(32) NULL,
    `requestPayload` JSON NULL,
    `responsePayload` JSON NULL,
    `httpStatus` INTEGER NULL,
    `resultCode` VARCHAR(40) NULL,
    `bizResultCode` VARCHAR(40) NULL,
    `success` BOOLEAN NOT NULL DEFAULT false,
    `durationMs` INTEGER NULL,
    `errorMessage` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_sqb_api_log_endpoint_time`(`endpoint`, `createdAt`),
    INDEX `idx_sqb_api_log_client_time`(`clientSn`, `createdAt`),
    INDEX `idx_sqb_api_log_success_time`(`success`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
