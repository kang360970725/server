-- 小时单支持 0.5 小时粒度，避免 1.5 等时长被整数列取整。
ALTER TABLE `Order`
    MODIFY COLUMN `orderQuantity` DOUBLE NOT NULL DEFAULT 1;
