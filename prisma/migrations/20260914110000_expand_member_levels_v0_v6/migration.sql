UPDATE `member_profiles` SET `levelCode`='V0' WHERE `levelCode`='NONE';
UPDATE `member_level_configs` SET `code`='V0', `name`='初见会员', `description`='蓝猫会员起始等级' WHERE `code`='NONE';
INSERT INTO `member_level_configs` (`code`,`name`,`sortOrder`,`minRechargeAmount`,`minAnnualContribution`,`benefits`,`description`,`enabled`,`isDefault`,`createdAt`,`updatedAt`) VALUES
('V4','铂金会员',400,3000,0,'["铂金会员名片","专属客服优先响应"]','V4 铂金主题',true,false,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3)),
('V5','钻石会员',500,6000,0,'["钻石动态主题","稀有成就展示"]','V5 钻石主题',true,false,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3)),
('V6','星耀会员',600,10000,0,'["星耀专属名片","最高等级身份标识"]','V6 星耀主题',true,false,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE `updatedAt`=`updatedAt`;
