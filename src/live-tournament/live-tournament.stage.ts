import { canMemberEnterTournament, tournamentMemberEligibilitySelect } from './live-tournament.eligibility';
import { BadRequestException } from '@nestjs/common';
import { Prisma, LiveTournamentEntry } from '@prisma/client';
import { drawTournamentProvider } from './live-tournament.rules';

type Client = Prisma.TransactionClient;

function stagePlayer(entry?: LiveTournamentEntry) {
    if (!entry) return null;
    return {
        id: entry.id,
        competitionName: entry.competitionName || entry.gameNickname,
        gameNickname: entry.gameNickname,
        providerId: entry.providerId,
        drawnAt: entry.drawnAt,
        status: entry.status,
        firstRoundStartedAt: entry.firstRoundStartedAt,
    };
}

export async function getTournamentStage(db: Client, dayId: number, internal: boolean) {
    const day = await db.liveTournamentDay.findUnique({
        where: { id: dayId },
        include: {
            tournament: true,
            quotas: true,
            entries: {
                where: { activeMemberId: { not: null }, status: { in: ['QUEUED', 'ON_STAGE'] } },
                orderBy: [{ queuePosition: 'asc' }, { id: 'asc' }],
            },
        },
    });
    if (!day || (!internal && day.tournament.status === 'DRAFT')) throw new BadRequestException('赛事时段不可用');
    const current = day.entries.find(entry => entry.status === 'ON_STAGE');
    const next = day.entries.find(entry => entry.status === 'QUEUED');
    const providerUsers = day.rosterPublishedAt && day.tournament.status !== 'CLOSED'
        ? await db.user.findMany({
            where: { id: { in: day.quotas.map(quota => quota.providerId) } },
            select: { id: true, name: true, staffRating: { select: { name: true } } },
            orderBy: { id: 'asc' },
        })
        : [];
    const providers = providerUsers.map(provider => ({
        id: provider.id,
        name: provider.name,
        serviceRank: provider.staffRating?.name || '未评级',
    }));
    function player(entry?: LiveTournamentEntry) {
        const result = stagePlayer(entry);
        return internal && result ? { ...result, gameAccountId: entry!.gameAccountId } : result;
    }
    const tournament = day.tournament;
    const counts = await db.liveTournamentEntry.groupBy({
        by: ['status'],
        where: { tournamentId: tournament.id, activeMemberId: { not: null }, status: { not: 'VOID' } },
        _count: { _all: true },
    });
    const occupied = counts.reduce((total, row) => total + row._count._all, 0);
    const pending = counts.find(row => row.status === 'PENDING_PAYMENT')?._count._all ?? 0;
    const now = new Date();
    return {
        leaderboard: tournament.leaderboardSnapshot, locked: Boolean(tournament.leaderboardLockedAt),
        title: tournament.title, current: player(current), next: player(next), providers,
        day: {
            id: day.id,
            startsAt: day.startsAt,
            endsAt: day.endsAt,
            capacity: day.capacity,
        },
        sales: {
            paid: occupied - pending,
            remaining: Math.max(0, Math.min(70, tournament.ticketLimit) - occupied),
            threshold: tournament.bookingThreshold,
            booked: Boolean(tournament.bookingOpenedAt) && tournament.status === 'PUBLISHED',
            open: tournament.status === 'PUBLISHED' && now >= tournament.salesStartAt && now < tournament.salesEndAt,
        },
    };
}

export async function updateTournamentStage(db: Client, dayId: number, entryId: number, action: string) {
    const ref = await db.liveTournamentDay.findUnique({ where: { id: dayId }, select: { tournamentId: true } });
    if (!ref) throw new BadRequestException('赛事时段不可用');
    await db.$queryRaw`SELECT id FROM LiveTournament WHERE id = ${ref.tournamentId} FOR UPDATE`;
    await db.$queryRaw`SELECT id FROM LiveTournamentDay WHERE id = ${dayId} FOR UPDATE`;
    const day = await db.liveTournamentDay.findUnique({
        where: { id: dayId }, include: { tournament: true, quotas: true },
    });
    if (!day || day.tournament.status !== 'PUBLISHED') throw new BadRequestException('赛事未开放');
    const entries = await db.liveTournamentEntry.findMany({
        where: { dayId, activeMemberId: { not: null } },
        orderBy: [{ queuePosition: 'asc' }, { id: 'asc' }],
    });
    const current = entries.find(entry => entry.status === 'ON_STAGE');
    const now = new Date();
    let releasedQueuePosition: number | null = null;
    let data: Prisma.LiveTournamentEntryUpdateManyMutationInput;
    let status: 'QUEUED' | 'ON_STAGE';
    switch (action) {
        case 'stage-enter': {
            if (current?.id === entryId) return;
            if (current) throw new BadRequestException('请先结束当前选手的比赛');
            const next = entries.find(entry => entry.status === 'QUEUED');
            if (next?.id !== entryId) throw new BadRequestException('候赛顺序已更新，请刷新后重试');
            if (!day.rosterPublishedAt) throw new BadRequestException('请先发布当日转盘名单');
            const member = await db.user.findUnique({ where: { id: next.memberId }, select: tournamentMemberEligibilitySelect });
            if (!canMemberEnterTournament(member)) throw new BadRequestException('当前会员没有参赛资格');
            status = 'QUEUED';
            releasedQueuePosition = next.queuePosition;
            const appearance = await db.liveTournamentEntry.aggregate({
                where: { dayId, appearanceSequence: { not: null } },
                _max: { appearanceSequence: true },
            });
            data = {
                status: 'ON_STAGE',
                onStageAt: now,
                appearanceSequence: (appearance._max.appearanceSequence ?? 0) + 1,
                queuePosition: null,
            };
            break;
        }
        case 'stage-draw': {
            if (!current || current.id !== entryId) throw new BadRequestException('请先确认选手上场');
            if (current.providerId !== null) {
                if (!current.firstRoundStartedAt) {
                    await db.liveTournamentEntry.updateMany({
                        where: { id: entryId, dayId, status: 'ON_STAGE', activeMemberId: { not: null }, firstRoundStartedAt: null },
                        data: { firstRoundStartedAt: now },
                    });
                }
                return;
            }
            const quotas = day.quotas.map(quota => ({
                ...quota,
                drawn: entries.filter(entry => entry.providerId === quota.providerId).length,
            }));
            const remaining = entries.filter(entry => ['QUEUED', 'ON_STAGE', 'BOOKED'].includes(entry.status) && entry.providerId === null).length;
            try {
                data = {
                    providerId: drawTournamentProvider(quotas, remaining),
                    drawnAt: now,
                    firstRoundStartedAt: current.firstRoundStartedAt ?? now,
                };
            } catch (error) {
                if (!(error instanceof RangeError)) throw error;
                throw new BadRequestException(error.message);
            }
            status = 'ON_STAGE';
            break;
        }
        case 'stage-start':
        case 'stage-finish':
            if (!current || current.id !== entryId || !current.providerId) throw new BadRequestException('请先锁定服务者');
            if (action === 'stage-finish' && !current.firstRoundStartedAt) throw new BadRequestException('请先记录首局开打');
            status = 'ON_STAGE';
            data = action === 'stage-start'
                ? { firstRoundStartedAt: current.firstRoundStartedAt ?? now }
                : {
                    status: await db.liveTournamentRound.count({ where: { entryId, publishedAt: { not: null } } }) === 2 ? 'FINISHED' : 'SCORING',
                    queuePosition: null,
                };
            break;
        default:
            throw new BadRequestException('未知直播操作');
    }
    const updated = await db.liveTournamentEntry.updateMany({
        where: { id: entryId, dayId, status, activeMemberId: { not: null } },
        data,
    });
    if (!updated.count) throw new BadRequestException('选手状态已更新，请刷新后重试');
    if (action === 'stage-enter' && releasedQueuePosition !== null) {
        await db.liveTournamentEntry.updateMany({
            where: { dayId, status: 'QUEUED', queuePosition: { gt: releasedQueuePosition } },
            data: { queuePosition: { decrement: 1 } },
        });
    }
}
