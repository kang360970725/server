-- AlterTable
ALTER TABLE `system_announcements` ADD COLUMN `audience` ENUM('ADMIN', 'APPLET', 'ALL') NOT NULL DEFAULT 'ALL';
