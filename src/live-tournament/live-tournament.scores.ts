import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { rankTournamentCompetitors, TournamentRoundScore } from './live-tournament.rules';

type Tx = Prisma.TransactionClient;
type PublicRow = { ticketId: number; rank: number };

export async function lockTournamentScoring(tx: Tx, tournamentId: number) {
    await tx.$queryRaw`SELECT id FROM LiveTournament WHERE id = ${tournamentId} FOR UPDATE`;
    const event = await tx.liveTournament.findUnique({ where: { id: tournamentId } });
    if (!event || event.status !== 'PUBLISHED' || event.leaderboardLockedAt) {
        throw new BadRequestException('赛事未开放录分或已锁榜');
    }
    return event;
}

export async function publishTournamentRound(tx: Tx, entryId: number, roundNumber: number) {
    const ref = await tx.liveTournamentEntry.findUnique({ where: { id: entryId }, select: { tournamentId: true } });
    if (!ref || ![1, 2].includes(roundNumber)) throw new BadRequestException('请选择有效选手和局次');
    const event = await lockTournamentScoring(tx, ref.tournamentId);
    const entry = await tx.liveTournamentEntry.findUniqueOrThrow({ where: { id: entryId }, include: { rounds: true } });
    const round = entry.rounds.find(item => item.roundNumber === roundNumber);
    if (!entry.usedAt || !round || round.kills === null || !['ON_STAGE', 'SCORING', 'FINISHED'].includes(entry.status)) {
        throw new BadRequestException('请先保存有效成绩');
    }
    const publishedScore = {
        kills: round.kills,
        firstKillElapsedMs: round.firstKillElapsedMs,
        firstKillAtMs: round.firstKillAt?.getTime() ?? null,
        forfeited: round.forfeited,
    };
    const previousScore = round.publishedScore as typeof publishedScore | null;
    const storedSnapshot = event.leaderboardSnapshot as unknown as {
        overall?: Array<PublicRow & { fastestScoreElapsedMs?: number | null }>;
    } | null;
    const needsUnifiedLeaderboardUpgrade = storedSnapshot?.overall?.some(row =>
        !Object.prototype.hasOwnProperty.call(row, 'fastestScoreElapsedMs'),
    ) ?? false;
    if (previousScore && Object.keys(publishedScore).every(key =>
        publishedScore[key as keyof typeof publishedScore] === previousScore[key as keyof typeof publishedScore]) &&
        !needsUnifiedLeaderboardUpgrade) {
        return;
    }
    await tx.liveTournamentRound.update({
        where: { entryId_roundNumber: { entryId, roundNumber } },
        data: { publishedScore, publishedAt: new Date() },
    });
    if (entry.status === 'SCORING' && entry.rounds.some(item => item.roundNumber !== roundNumber && item.publishedScore)) {
        await tx.liveTournamentEntry.update({ where: { id: entryId }, data: { status: 'FINISHED' } });
    }

    const entries = await tx.liveTournamentEntry.findMany({
        where: { tournamentId: event.id, activeMemberId: { not: null }, usedAt: { not: null } },
        include: { rounds: true },
    });
    const contestants = entries.map(item => ({
        ticketId: item.id,
        name: item.competitionName || item.gameNickname || '参赛选手',
        checkedInToStageAtMs: item.onStageAt?.getTime() ?? 0,
        publishedRounds: item.rounds.flatMap(result => {
            const score = result.publishedScore as unknown as (TournamentRoundScore & { forfeited: boolean }) | null;
            return score ? [{ ...score, roundNumber: result.roundNumber }] : [];
        }),
    }));
    const ranks = new Map(storedSnapshot?.overall?.map(row => [row.ticketId, row.rank]));
    const overall = rankTournamentCompetitors(contestants).map(row => ({
        ticketId: row.ticketId, name: row.name, rank: row.rank, points: row.totalPoints,
        played: row.publishedRounds.filter(item => !item.forfeited).length,
        fastestScoreElapsedMs: row.fastestFirstKill?.elapsed ?? null,
        previousRank: ranks.get(row.ticketId) ?? null,
    }));
    const singles = contestants.flatMap(item => item.publishedRounds
        .filter(score => !score.forfeited && score.kills > 0)
        .map(score => ({ ...score, name: item.name, ticketId: item.ticketId })));
    const byKills = [...singles].sort((a, b) => b.kills - a.kills || a.ticketId - b.ticketId || a.roundNumber - b.roundNumber);
    const byFirstKill = singles.filter(score => score.firstKillElapsedMs !== null)
        .sort((a, b) => a.firstKillElapsedMs! - b.firstKillElapsedMs! || a.firstKillAtMs! - b.firstKillAtMs! || a.ticketId - b.ticketId);
    return tx.liveTournament.update({
        where: { id: event.id }, data: { leaderboardSnapshot: { overall, byKills, byFirstKill } },
    });
}

export async function closeTournamentLeaderboard(tx: Tx, tournamentId: number) {
    await lockTournamentScoring(tx, tournamentId);
    const unfinished = await tx.liveTournamentEntry.count({
        where: { tournamentId, activeMemberId: { not: null }, status: { in: ['ON_STAGE', 'QUEUED', 'SCORING'] } },
    });
    if (unfinished) throw new BadRequestException('请先处理候赛、在赛和待统计选手');
    const rounds = await tx.liveTournamentRound.findMany({
        where: { entry: { tournamentId, activeMemberId: { not: null } } },
    });
    if (rounds.some(round => {
        const published = round.publishedScore as Prisma.JsonObject | null;
        return !published || published.kills !== round.kills ||
            published.firstKillElapsedMs !== round.firstKillElapsedMs ||
            published.firstKillAtMs !== (round.firstKillAt?.getTime() ?? null) ||
            published.forfeited !== round.forfeited;
    })) throw new BadRequestException('还有成绩待发布，请发布后再锁榜');
    return tx.liveTournament.update({
        where: { id: tournamentId }, data: { leaderboardLockedAt: new Date(), status: 'CLOSED' },
    });
}
