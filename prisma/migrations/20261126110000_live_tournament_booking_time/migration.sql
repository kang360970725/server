ALTER TABLE `LiveTournamentEntry`
    ADD COLUMN `bookedAt` DATETIME(3) NULL;

-- Existing reschedules already have an exact operation timestamp. Initial
-- historical bookings did not store one independently, so leave those NULL
-- instead of presenting an unrelated updatedAt value as the booking time.
UPDATE `LiveTournamentEntry`
SET `bookedAt` = `rescheduledAt`
WHERE `rescheduledAt` IS NOT NULL;
