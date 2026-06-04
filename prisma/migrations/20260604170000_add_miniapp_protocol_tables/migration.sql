-- CreateTable
CREATE TABLE `miniapp_protocol_categories` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(120) NOT NULL,
    `description` VARCHAR(255) NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `idx_miniapp_protocol_category_enabled_sort`(`enabled`, `sort`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `miniapp_protocols` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `categoryId` INTEGER NOT NULL,
    `key` VARCHAR(64) NOT NULL,
    `title` VARCHAR(120) NOT NULL,
    `coverImage` TEXT NULL,
    `content` LONGTEXT NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `remark` VARCHAR(255) NULL,
    `sort` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `miniapp_protocols_key_key`(`key`),
    INDEX `idx_miniapp_protocol_category_sort`(`categoryId`, `enabled`, `sort`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `miniapp_protocols` ADD CONSTRAINT `miniapp_protocols_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `miniapp_protocol_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
