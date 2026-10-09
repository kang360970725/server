ALTER TABLE `staff_public_cards`
  ADD COLUMN `publicVisible` BOOLEAN NOT NULL DEFAULT false;

UPDATE `staff_public_cards`
SET `publicVisible` = true
WHERE `status` = 'APPROVED';

DROP INDEX `idx_staff_public_card_review` ON `staff_public_cards`;
CREATE INDEX `idx_staff_public_card_review`
  ON `staff_public_cards`(`status`, `publicVisible`, `submittedAt`);
