-- 商品项目：支持多标签（projectType 扩容）+ 划线价（originPrice）
ALTER TABLE `GameProject`
  MODIFY COLUMN `projectType` TEXT NULL,
  ADD COLUMN `originPrice` DOUBLE NULL AFTER `price`;

