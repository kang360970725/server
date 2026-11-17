ALTER TABLE `LiveTournament`
  MODIFY `startsAt` DATETIME(3) NULL,
  MODIFY `endsAt` DATETIME(3) NULL,
  ADD COLUMN `memberTicketLimit` INTEGER NOT NULL DEFAULT 1;

ALTER TABLE `LiveTournamentEntry`
  ADD INDEX `idx_live_tournament_active_member` (`tournamentId`, `activeMemberId`);
ALTER TABLE `LiveTournamentEntry`
  DROP INDEX `LiveTournamentEntry_tournamentId_activeMemberId_key`;
