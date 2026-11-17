ALTER TABLE `LiveTournament` ADD COLUMN `leaderboardSnapshot` JSON NULL;
ALTER TABLE `LiveTournamentRound` ADD COLUMN `publishedScore` JSON NULL;
