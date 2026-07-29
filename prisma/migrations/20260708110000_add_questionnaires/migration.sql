CREATE TABLE `questionnaires` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT NULL,
  `scope` ENUM('INTERNAL_STAFF', 'MEMBER_LOGIN', 'UNRESTRICTED') NOT NULL DEFAULT 'UNRESTRICTED',
  `status` ENUM('DRAFT', 'PUBLISHED', 'CLOSED') NOT NULL DEFAULT 'DRAFT',
  `publishedAt` DATETIME(3) NULL,
  `startAt` DATETIME(3) NULL,
  `endAt` DATETIME(3) NULL,
  `allowEditSubmit` BOOLEAN NOT NULL DEFAULT false,
  `createdBy` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `idx_questionnaire_scope_status_time`(`scope`, `status`, `startAt`, `endAt`),
  INDEX `idx_questionnaire_created_by`(`createdBy`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `questionnaire_questions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `questionnaireId` INTEGER NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `description` TEXT NULL,
  `type` ENUM('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TEXT') NOT NULL,
  `required` BOOLEAN NOT NULL DEFAULT false,
  `sortOrder` INTEGER NOT NULL DEFAULT 100,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `idx_questionnaire_question_order`(`questionnaireId`, `sortOrder`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `questionnaire_options` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `questionId` INTEGER NOT NULL,
  `label` VARCHAR(255) NOT NULL,
  `sortOrder` INTEGER NOT NULL DEFAULT 100,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `idx_questionnaire_option_order`(`questionId`, `sortOrder`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `questionnaire_submissions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `questionnaireId` INTEGER NOT NULL,
  `userId` INTEGER NULL,
  `submitterName` VARCHAR(100) NULL,
  `submitterPhone` VARCHAR(64) NULL,
  `submitterUserType` VARCHAR(32) NULL,
  `submitterStaffStatus` VARCHAR(32) NULL,
  `visitorToken` VARCHAR(128) NULL,
  `clientIp` VARCHAR(128) NULL,
  `userAgent` VARCHAR(512) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uniq_questionnaire_submission_user`(`questionnaireId`, `userId`),
  INDEX `idx_questionnaire_submission_time`(`questionnaireId`, `createdAt`),
  INDEX `idx_questionnaire_submission_visitor`(`visitorToken`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `questionnaire_answers` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `submissionId` INTEGER NOT NULL,
  `questionId` INTEGER NOT NULL,
  `optionId` INTEGER NULL,
  `textValue` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `idx_questionnaire_answer_submission`(`submissionId`),
  INDEX `idx_questionnaire_answer_question`(`questionId`),
  INDEX `idx_questionnaire_answer_option`(`optionId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `questionnaires`
  ADD CONSTRAINT `questionnaires_createdBy_fkey`
  FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `questionnaire_questions`
  ADD CONSTRAINT `questionnaire_questions_questionnaireId_fkey`
  FOREIGN KEY (`questionnaireId`) REFERENCES `questionnaires`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `questionnaire_options`
  ADD CONSTRAINT `questionnaire_options_questionId_fkey`
  FOREIGN KEY (`questionId`) REFERENCES `questionnaire_questions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `questionnaire_submissions`
  ADD CONSTRAINT `questionnaire_submissions_questionnaireId_fkey`
  FOREIGN KEY (`questionnaireId`) REFERENCES `questionnaires`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `questionnaire_submissions_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `questionnaire_answers`
  ADD CONSTRAINT `questionnaire_answers_submissionId_fkey`
  FOREIGN KEY (`submissionId`) REFERENCES `questionnaire_submissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `questionnaire_answers_questionId_fkey`
  FOREIGN KEY (`questionId`) REFERENCES `questionnaire_questions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `questionnaire_answers_optionId_fkey`
  FOREIGN KEY (`optionId`) REFERENCES `questionnaire_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
