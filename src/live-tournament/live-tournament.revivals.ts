import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

const revocableStatuses = ['UNBOOKED', 'BOOKED', 'QUEUED', 'ABSENT'] as const;

export async function grantTournamentRevival(tx: Tx, sourceEntryId: number, operatorId: number) {
    const sourceRef = await tx.liveTournamentEntry.findUnique({
        where: { id: sourceEntryId },
        select: { tournamentId: true, orderId: true },
    });
    if (!sourceRef) throw new BadRequestException('参赛记录不存在');
    await tx.$queryRaw`SELECT id FROM LiveTournament WHERE id = ${sourceRef.tournamentId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM LiveTournamentEntry WHERE orderId = ${sourceRef.orderId} FOR UPDATE`;

    const [source, attempts] = await Promise.all([
        tx.liveTournamentEntry.findUnique({
            where: { id: sourceEntryId }, include: { tournament: true, rounds: true },
        }),
        tx.liveTournamentEntry.findMany({
            where: { orderId: sourceRef.orderId }, orderBy: { attemptNumber: 'asc' },
        }),
    ]);
    if (!source || source.tournament.status !== 'PUBLISHED' || source.tournament.leaderboardLockedAt) {
        throw new BadRequestException('赛事已结束或当前不可复活');
    }
    if (source.status !== 'FINISHED' || !source.usedAt || source.rounds.filter(round => round.publishedAt).length < 2) {
        throw new BadRequestException('选手完成本次两局比赛并发布成绩后才可复活');
    }
    const active = attempts.find(entry => entry.isRevival && !['FINISHED', 'VOID'].includes(entry.status));
    if (active) throw new BadRequestException('该选手已有待完成的复活参赛，请勿重复操作');

    const attemptNumber = Math.max(0, ...attempts.map(entry => entry.attemptNumber)) + 1;
    const now = new Date();
    const created = await tx.liveTournamentEntry.create({
        data: {
            tournamentId: source.tournamentId,
            orderId: source.orderId,
            memberId: source.memberId,
            activeMemberId: source.memberId,
            attemptNumber,
            isRevival: true,
            status: 'UNBOOKED',
            contactName: source.contactName,
            contactPhone: source.contactPhone,
            gameAccountId: source.gameAccountId,
            gameNickname: source.gameNickname,
            gameRank: source.gameRank,
            competitionName: source.competitionName,
            revivalGrantedAt: now,
            revivalGrantedBy: operatorId,
        },
    });
    await tx.userLog.create({
        data: {
            userId: operatorId,
            action: 'LIVE_TOURNAMENT_GRANT_REVIVAL',
            targetType: 'LIVE_TOURNAMENT_ENTRY',
            targetId: created.id,
            oldData: { sourceEntryId, orderId: source.orderId } as any,
            newData: { attemptNumber, status: created.status } as any,
            remark: '允许选手复活并重新预约',
        },
    });
    return created;
}

export async function revokeTournamentRevival(tx: Tx, entryId: number, operatorId: number) {
    const reference = await tx.liveTournamentEntry.findUnique({
        where: { id: entryId }, select: { tournamentId: true, orderId: true, dayId: true },
    });
    if (!reference) throw new BadRequestException('复活参赛记录不存在');
    await tx.$queryRaw`SELECT id FROM LiveTournament WHERE id = ${reference.tournamentId} FOR UPDATE`;
    if (reference.dayId) await tx.$queryRaw`SELECT id FROM LiveTournamentDay WHERE id = ${reference.dayId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM LiveTournamentEntry WHERE id = ${entryId} FOR UPDATE`;

    const entry = await tx.liveTournamentEntry.findUnique({ where: { id: entryId }, include: { tournament: true } });
    if (!entry?.isRevival) throw new BadRequestException('仅复活参赛可以撤销');
    if (entry.status === 'VOID' && entry.revivalRevokedAt) return { ...entry, idempotent: true };
    if (entry.tournament.status !== 'PUBLISHED' || entry.firstRoundStartedAt || entry.usedAt ||
        entry.providerId || entry.appearanceSequence !== null || !revocableStatuses.includes(entry.status as any)) {
        throw new BadRequestException('该复活参赛已开始，不能撤销');
    }
    const now = new Date();
    const saved = await tx.liveTournamentEntry.update({
        where: { id: entry.id },
        data: {
            status: 'VOID', activeMemberId: null, dayId: null, queuePosition: null,
            checkedInAt: null, preMatchReminderAt: null,
            revivalRevokedAt: now, revivalRevokedBy: operatorId,
        },
    });
    if (entry.dayId !== null && entry.queuePosition !== null) {
        await tx.liveTournamentEntry.updateMany({
            where: { dayId: entry.dayId, status: 'QUEUED', queuePosition: { gt: entry.queuePosition } },
            data: { queuePosition: { decrement: 1 } },
        });
    }
    await tx.userLog.create({
        data: {
            userId: operatorId,
            action: 'LIVE_TOURNAMENT_REVOKE_REVIVAL',
            targetType: 'LIVE_TOURNAMENT_ENTRY',
            targetId: entry.id,
            oldData: { status: entry.status, dayId: entry.dayId, queuePosition: entry.queuePosition } as any,
            newData: { status: 'VOID' } as any,
            remark: '撤销选手复活参赛',
        },
    });
    return { ...saved, idempotent: false };
}
