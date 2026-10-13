ALTER TABLE `Order`
    ADD COLUMN `preselectedPlayerIds` JSON NULL,
    ADD COLUMN `preselectedAttributionIds` JSON NULL,
    ADD COLUMN `preselectedAttributionType` VARCHAR(20) NULL;
