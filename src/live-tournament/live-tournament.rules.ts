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
        .sort((a, b) =>
            b.totalPoints - a.totalPoints ||
            b.bestKills - a.bestKills ||
            (a.fastestFirstKill?.elapsed ?? Infinity) - (b.fastestFirstKill?.elapsed ?? Infinity) ||
            (a.fastestFirstKill?.at ?? Infinity) - (b.fastestFirstKill?.at ?? Infinity) ||
            a.checkedInToStageAtMs - b.checkedInToStageAtMs ||
            a.ticketId - b.ticketId,
        )
        .map((competitor, index) => ({ ...competitor, rank: competitor.totalPoints > 0 ? index + 1 : null }));
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
    lastProviderId?: number | null,
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

    // Simulate every possible next draw. A candidate is valid only when the
    // remaining draws can still satisfy every provider's minimum and maximum.
    const feasible = quotas.filter((candidate) => {
        if (candidate.drawn >= candidate.maximum) return false;
        const after = quotas.map(quota => quota.providerId === candidate.providerId
            ? {...quota, drawn: quota.drawn + 1}
            : quota);
        const drawsAfter = remainingDraws - 1;
        const minimumAfter = after.reduce(
            (total, quota) => total + Math.max(0, quota.minimum - quota.drawn), 0,
        );
        const capacityAfter = after.reduce(
            (total, quota) => total + Math.max(0, quota.maximum - quota.drawn), 0,
        );
        return drawsAfter >= minimumAfter && drawsAfter <= capacityAfter;
    });
    if (!feasible.length) throw new RangeError('没有符合剩余配额的服务者');

    // Prefer a different provider from the previous draw. Consecutive draws are
    // allowed only when every alternative would make the remaining quota invalid.
    const nonConsecutive = lastProviderId == null
        ? feasible
        : feasible.filter(quota => quota.providerId !== lastProviderId);
    const pool = nonConsecutive.length ? nonConsecutive : feasible;
    return pool[randomInt(pool.length)].providerId;
}
