import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { rankTournamentCompetitors, TournamentRoundScore } from './live-tournament.rules';

type Tx = Prisma.TransactionClient;
type PublicRow = { ticketId: number; rank: number | null; previousRank?: number | null };
type StoredLeaderboard = { version?: number; overall?: PublicRow[] };
const leaderboardVersion = 3;

function storedLeaderboard(value: Prisma.JsonValue): StoredLeaderboard | null {
    return value as StoredLeaderboard | null;
}

export async function readTournamentLeaderboard(tx: Tx, tournamentId: number, snapshot: Prisma.JsonValue) {
    const stored = storedLeaderboard(snapshot);
    if (!stored || stored.version === leaderboardVersion) return snapshot;
    const previousRanks = new Map(stored.overall?.map(row => [row.ticketId, row.previousRank ?? null]));
    return buildTournamentLeaderboard(tx, tournamentId, previousRanks);
}

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
    const storedSnapshot = storedLeaderboard(event.leaderboardSnapshot);
    if (previousScore && Object.keys(publishedScore).every(key =>
        publishedScore[key as keyof typeof publishedScore] === previousScore[key as keyof typeof publishedScore]) &&
        storedSnapshot?.version === leaderboardVersion) {
        return;
    }
    await tx.liveTournamentRound.update({
        where: { entryId_roundNumber: { entryId, roundNumber } },
        data: { publishedScore, publishedAt: new Date() },
    });
    if (entry.status === 'SCORING' && entry.rounds.some(item => item.roundNumber !== roundNumber && item.publishedScore)) {
        await tx.liveTournamentEntry.update({ where: { id: entryId }, data: { status: 'FINISHED' } });
    }

    const ranks = new Map(storedSnapshot?.overall?.map(row => [row.ticketId, row.rank]));
    const snapshot = await buildTournamentLeaderboard(tx, event.id, ranks);
    return tx.liveTournament.update({
        where: { id: event.id }, data: { leaderboardSnapshot: snapshot },
    });
}

async function buildTournamentLeaderboard(tx: Tx, tournamentId: number, previousRanks: Map<number, number | null>) {
    const entries = await tx.liveTournamentEntry.findMany({
        where: { tournamentId, activeMemberId: { not: null }, usedAt: { not: null } },
        include: { rounds: true },
    });
    const attempts = entries.map(item => ({
        ticketId: item.id,
        memberId: item.memberId,
        isRevival: item.isRevival,
        name: item.competitionName || item.gameNickname || '参赛选手',
        checkedInToStageAtMs: item.onStageAt?.getTime() ?? 0,
        publishedRounds: item.rounds.flatMap(result => {
            const score = result.publishedScore as unknown as (TournamentRoundScore & { forfeited: boolean }) | null;
            return score ? [{ ...score, roundNumber: result.roundNumber }] : [];
        }),
    })).filter(item => item.publishedRounds.length > 0 && (!item.isRevival || item.publishedRounds.length === 2));
    // A revival is one complete two-round attempt. Select the best whole attempt for
    // each member first, then build every board from that same attempt so scores from
    // different attempts can never be combined.
    const seenMembers = new Set<number>();
    const contestants = rankTournamentCompetitors(attempts).filter(item => {
        if (seenMembers.has(item.memberId)) return false;
        seenMembers.add(item.memberId);
        return true;
    });
    const overall = rankTournamentCompetitors(contestants).map(row => ({
        ticketId: row.ticketId, name: row.name, rank: row.rank, points: row.totalPoints,
        played: row.publishedRounds.filter(item => !item.forfeited).length,
        fastestScoreElapsedMs: row.fastestFirstKill?.elapsed ?? null,
        previousRank: row.rank === null ? null : previousRanks.get(row.ticketId) ?? null,
    }));
    const singles = contestants.flatMap(item => item.publishedRounds
        .filter(score => !score.forfeited && score.kills > 0)
        .map(score => ({
            ...score, name: item.name, ticketId: item.ticketId, memberId: item.memberId,
            checkedInToStageAtMs: item.checkedInToStageAtMs,
        })));
    const byParticipation = (a: (typeof singles)[number], b: (typeof singles)[number]) =>
        a.checkedInToStageAtMs - b.checkedInToStageAtMs || a.ticketId - b.ticketId || a.roundNumber - b.roundNumber;
    function bestPerMember(sorted: typeof singles) {
        const seen = new Set<number>();
        return sorted.filter(row => {
            const key = row.memberId ?? row.ticketId;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).map(({ memberId, checkedInToStageAtMs, ...row }, index) => ({ ...row, rank: index + 1 }));
    }
    const byKills = bestPerMember([...singles].sort((a, b) => b.kills - a.kills || byParticipation(a, b)));
    const byFirstKill = bestPerMember(singles.filter(score => score.firstKillElapsedMs !== null)
        .sort((a, b) => a.firstKillElapsedMs! - b.firstKillElapsedMs! ||
            (a.firstKillAtMs ?? Infinity) - (b.firstKillAtMs ?? Infinity) || byParticipation(a, b)));
    return { version: leaderboardVersion, overall, byKills, byFirstKill };
}

export async function closeTournamentLeaderboard(tx: Tx, tournamentId: number) {
    await lockTournamentScoring(tx, tournamentId);
    const unfinished = await tx.liveTournamentEntry.count({
        where: {
            tournamentId, activeMemberId: { not: null },
            OR: [
                { status: { in: ['ON_STAGE', 'QUEUED', 'SCORING'] } },
                { isRevival: true, status: { notIn: ['FINISHED', 'VOID'] } },
            ],
        },
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
