import { canMemberEnterTournament, tournamentMemberEligibilitySelect } from './live-tournament.eligibility';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export function tournamentDate(value: unknown) {
    const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
    if (!Number.isFinite(date.getTime())) throw new BadRequestException('请输入有效时间');
    return date;
}

export function tournamentText(value: unknown, label: string, optional = false) {
    const text = typeof value === 'string' ? value.trim() : '';
    if ((!optional && !text) || text.length > 100) throw new BadRequestException(`请核对${label}（最多 100 字）`);
    return text || null;
}

export async function bookTournament(tx: Tx, memberId: number, input: Record<string, unknown>) {
    const orderId = Number(input.orderId);
    const entryId = Number(input.entryId);
    const dayId = Number(input.dayId);
    if (!Number.isSafeInteger(orderId) || orderId <= 0 || !Number.isSafeInteger(dayId) || dayId <= 0 ||
        (input.entryId !== undefined && (!Number.isSafeInteger(entryId) || entryId <= 0))) {
        throw new BadRequestException('请选择有效门票和时段');
    }
    await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${orderId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM LiveTournamentDay WHERE id = ${dayId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM LiveTournamentEntry WHERE orderId = ${orderId} FOR UPDATE`;
    const ticket = input.entryId !== undefined
        ? await tx.liveTournamentEntry.findFirst({ where: { id: entryId, orderId }, include: { tournament: true } })
        : await tx.liveTournamentEntry.findFirst({
            where: { orderId, activeMemberId: memberId, status: { not: 'VOID' } },
            orderBy: { attemptNumber: 'desc' }, include: { tournament: true },
        });
    if (!ticket || ticket.memberId !== memberId || ticket.activeMemberId !== memberId ||
        !['UNBOOKED', 'BOOKED', 'QUEUED', 'ABSENT'].includes(ticket.status) ||
        ticket.firstRoundStartedAt || ticket.usedAt || !ticket.tournament.bookingOpenedAt ||
        ticket.tournament.status !== 'PUBLISHED') {
        throw new BadRequestException('当前门票不可预约或改约');
    }
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    if (order.status === 'REFUNDED' || order.status === 'CANCELLED') throw new BadRequestException('门票订单正在退款或已取消');
    const member = await tx.user.findUniqueOrThrow({ where: { id: memberId }, select: { name: true, phone: true, ...tournamentMemberEligibilitySelect } });
    if (!canMemberEnterTournament(member)) throw new BadRequestException('店内认证服务者不能参赛');
    const wechat = await tx.userWechatBinding.findFirst({
        where: { userId: memberId, platform: 'MINIAPP', nickname: { not: null } },
        orderBy: { updatedAt: 'desc' }, select: { nickname: true },
    });
    const day = await tx.liveTournamentDay.findUnique({ where: { id: dayId } });
    if (!day || day.tournamentId !== ticket.tournamentId || day.startsAt <= new Date()) {
        throw new BadRequestException('请选择尚未开始的赛事时段');
    }
    const changingDay = ticket.dayId !== null && (ticket.dayId !== dayId || ticket.status === 'ABSENT');
    if (changingDay && ticket.rescheduledAt) throw new BadRequestException('门票只能改约一次');
    const booked = await tx.$queryRaw<{id: number}[]>`
        SELECT id FROM LiveTournamentEntry WHERE dayId = ${dayId}
        AND activeMemberId IS NOT NULL AND status NOT IN ('VOID', 'ABSENT') FOR UPDATE
    `;
    if ((ticket.dayId !== dayId || ticket.status === 'ABSENT') && booked.length >= day.capacity) {
        throw new BadRequestException('该时段已约满');
    }
    const game = ticket.checkedInAt && !changingDay ? {} : {
        gameAccountId: tournamentText(input.gameAccountId, '游戏 ID'),
        gameNickname: tournamentText(input.gameNickname, '游戏昵称'),
        gameRank: tournamentText(input.gameRank, '段位'),
        competitionName: tournamentText(input.competitionName, '参赛昵称', true),
    };
    const saved = await tx.liveTournamentEntry.update({
        where: { id: ticket.id },
        data: {
            ...game, dayId, contactName: (wechat?.nickname || member.name)?.slice(0, 100), contactPhone: member.phone,
            ...(changingDay || ticket.status === 'UNBOOKED' || ticket.status === 'ABSENT'
                ? { status: 'BOOKED', checkedInAt: null, queuePosition: null } : {}),
            ...(changingDay ? { rescheduledAt: new Date(), preMatchReminderAt: null } : {}),
        },
    });
    return { ...saved, bookingChanged: changingDay || ticket.status === 'UNBOOKED', startsAt: day.startsAt };
}

export async function adminRescheduleTournamentEntry(tx: Tx, entryId: number, targetDayId: number) {
    if (![entryId, targetDayId].every(id => Number.isSafeInteger(id) && id > 0)) {
        throw new BadRequestException('请选择有效选手和目标场次');
    }
    const reference = await tx.liveTournamentEntry.findUnique({
        where: { id: entryId }, select: { tournamentId: true, dayId: true },
    });
    if (!reference) throw new BadRequestException('参赛选手不存在');
    await tx.$queryRaw`SELECT id FROM LiveTournament WHERE id = ${reference.tournamentId} FOR UPDATE`;
    const lockDayIds = [...new Set([reference.dayId, targetDayId].filter((id): id is number => id !== null))].sort((a, b) => a - b);
    for (const id of lockDayIds) await tx.$queryRaw`SELECT id FROM LiveTournamentDay WHERE id = ${id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM LiveTournamentEntry WHERE id = ${entryId} FOR UPDATE`;

    const [entry, targetDay] = await Promise.all([
        tx.liveTournamentEntry.findUnique({ where: { id: entryId }, include: { tournament: true } }),
        tx.liveTournamentDay.findUnique({ where: { id: targetDayId } }),
    ]);
    if (!entry || !entry.activeMemberId || !['BOOKED', 'QUEUED', 'ABSENT'].includes(entry.status) ||
        entry.appearanceSequence !== null || entry.firstRoundStartedAt || entry.usedAt || entry.providerId ||
        entry.tournament.status !== 'PUBLISHED') {
        throw new BadRequestException('只有尚未上场的有效选手可以调整场次');
    }
    if (!targetDay || targetDay.tournamentId !== entry.tournamentId || targetDay.endsAt <= new Date()) {
        throw new BadRequestException('请选择尚未结束的同一赛事场次');
    }
    if (entry.dayId === targetDayId && entry.status !== 'ABSENT') {
        throw new BadRequestException('选手已在当前场次候赛');
    }
    const occupied = await tx.$queryRaw<{id: number}[]>`
        SELECT id FROM LiveTournamentEntry WHERE dayId = ${targetDayId} AND id <> ${entryId}
        AND activeMemberId IS NOT NULL AND status NOT IN ('VOID', 'ABSENT') FOR UPDATE
    `;
    if (occupied.length >= targetDay.capacity) throw new BadRequestException('目标场次已满，请先确认替补或释放席位');

    const targetQueued = Boolean(targetDay.rosterPublishedAt);
    const lastTarget = targetQueued ? await tx.liveTournamentEntry.aggregate({
        where: { dayId: targetDayId, status: 'QUEUED', id: { not: entryId } },
        _max: { queuePosition: true },
    }) : null;
    const sourceDayId = entry.dayId;
    const sourcePosition = entry.status === 'QUEUED' ? entry.queuePosition : null;
    const saved = await tx.liveTournamentEntry.update({
        where: { id: entryId },
        data: {
            dayId: targetDayId,
            status: targetQueued ? 'QUEUED' : 'BOOKED',
            queuePosition: targetQueued ? (lastTarget?._max.queuePosition ?? 0) + 1 : null,
            checkedInAt: targetQueued ? new Date() : null,
            rescheduledAt: new Date(), preMatchReminderAt: null,
        },
    });
    if (sourceDayId !== null && sourceDayId !== targetDayId && sourcePosition !== null) {
        await tx.liveTournamentEntry.updateMany({
            where: { dayId: sourceDayId, status: 'QUEUED', queuePosition: { gt: sourcePosition } },
            data: { queuePosition: { decrement: 1 } },
        });
    }
    return { ...saved, startsAt: targetDay.startsAt };
}

export async function updateTournamentQueue(tx: Tx, dayId: number, orderedIds: number[], absentId?: number) {
    await tx.$queryRaw`SELECT id FROM LiveTournamentDay WHERE id = ${dayId} FOR UPDATE`;
    // queuePosition only describes the current waiting queue. Keeping the old value after a
    // player leaves QUEUED creates duplicate positions and makes every reorder look corrupted.
    await tx.liveTournamentEntry.updateMany({
        where: { dayId, status: { not: 'QUEUED' }, queuePosition: { not: null } },
        data: { queuePosition: null },
    });
    const ids = [...orderedIds, ...(absentId === undefined ? [] : [absentId])];
    if (new Set(ids).size !== ids.length) throw new BadRequestException('名单中存在重复选手');
    const rows = await tx.liveTournamentEntry.findMany({
        where: { dayId, activeMemberId: { not: null }, status: { in: ['BOOKED', 'QUEUED'] } }, select: { id: true, status: true },
    });
    if (ids.some(id => !rows.some(row => row.id === id)) ||
        rows.some(row => row.status === 'QUEUED' && !ids.includes(row.id))) {
        throw new BadRequestException('出场名单已变更，请刷新后重试');
    }
    for (const [index, id] of orderedIds.entries()) {
        const updated = await tx.liveTournamentEntry.updateMany({
            where: { id, dayId, activeMemberId: { not: null }, status: { in: ['BOOKED', 'QUEUED'] } },
            data: { status: 'QUEUED', queuePosition: index + 1 },
        });
        if (!updated.count) throw new BadRequestException('出场名单已变更，请刷新后重试');
        await tx.liveTournamentEntry.updateMany({ where: { id, checkedInAt: null }, data: { checkedInAt: new Date() } });
    }
    if (absentId !== undefined) {
        const updated = await tx.liveTournamentEntry.updateMany({
            where: { id: absentId, dayId, activeMemberId: { not: null }, status: { in: ['BOOKED', 'QUEUED'] } },
            data: { status: 'ABSENT', queuePosition: null, checkedInAt: null },
        });
        if (!updated.count) throw new BadRequestException('出场名单已变更，请刷新后重试');
    }
}
