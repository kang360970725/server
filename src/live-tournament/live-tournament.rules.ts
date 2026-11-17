import { randomInt } from 'node:crypto';

export interface TournamentRoundScore {
    kills: number;
    firstKillElapsedMs: number | null;
    firstKillAtMs: number | null;
}

export interface TournamentCompetitor {
    ticketId: number;
    checkedInToStageAtMs: number;
    publishedRounds: readonly TournamentRoundScore[];
}

export function tournamentRoundPoints(kills: number): number {
    if (!Number.isSafeInteger(kills) || kills < 0) {
        throw new RangeError('击杀数必须为非负整数');
    }
    return Math.min(kills, 6);
}

export function rankTournamentCompetitors<T extends TournamentCompetitor>(competitors: readonly T[]) {
    return competitors
        .map((competitor) => {
            const rounds = competitor.publishedRounds;
            const firstKills = rounds
                .flatMap(({ firstKillElapsedMs, firstKillAtMs }) =>
                    firstKillElapsedMs === null || firstKillAtMs === null
                        ? []
                        : [{ elapsed: firstKillElapsedMs, at: firstKillAtMs }],
                )
                .sort((a, b) => a.elapsed - b.elapsed || a.at - b.at);
            return {
                ...competitor,
                totalPoints: rounds.reduce((total, round) => total + tournamentRoundPoints(round.kills), 0),
                bestKills: Math.max(0, ...rounds.map((round) => round.kills)),
                fastestFirstKill: firstKills[0],
            };
        })
        .filter((competitor) => competitor.totalPoints > 0)
        .sort((a, b) =>
            b.totalPoints - a.totalPoints ||
            b.bestKills - a.bestKills ||
            (a.fastestFirstKill?.elapsed ?? Infinity) - (b.fastestFirstKill?.elapsed ?? Infinity) ||
            (a.fastestFirstKill?.at ?? Infinity) - (b.fastestFirstKill?.at ?? Infinity) ||
            a.checkedInToStageAtMs - b.checkedInToStageAtMs ||
            a.ticketId - b.ticketId,
        )
        .map((competitor, index) => ({ ...competitor, rank: index + 1 }));
}

export interface TournamentProviderQuota {
    providerId: number;
    minimum: number;
    maximum: number;
    drawn: number;
}

export function drawTournamentProvider(
    quotas: readonly TournamentProviderQuota[],
    remainingDraws: number,
): number {
    if (!Number.isSafeInteger(remainingDraws) || remainingDraws < 1) {
        throw new RangeError('没有剩余抽取次数');
    }

    const remainingMinimum = quotas.reduce(
        (total, quota) => total + Math.max(0, quota.minimum - quota.drawn),
        0,
    );
    const remainingCapacity = quotas.reduce(
        (total, quota) => total + Math.max(0, quota.maximum - quota.drawn),
        0,
    );
    if (remainingDraws < remainingMinimum || remainingDraws > remainingCapacity) {
        throw new RangeError('剩余抽取次数与服务者保底或上限不匹配');
    }

    const eligible = quotas.filter((quota) =>
        quota.drawn < quota.maximum &&
        (remainingDraws > remainingMinimum || quota.drawn < quota.minimum),
    );
    return eligible[randomInt(eligible.length)].providerId;
}
