-- Keep the actual appearance sequence after a player leaves the waiting queue.
ALTER TABLE `LiveTournamentEntry`
    ADD COLUMN `appearanceSequence` INTEGER NULL;

CREATE UNIQUE INDEX `uq_live_tournament_day_appearance`
    ON `LiveTournamentEntry`(`dayId`, `appearanceSequence`);
