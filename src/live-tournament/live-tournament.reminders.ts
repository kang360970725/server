import { Prisma } from '@prisma/client';

const HOUR_MS = 60 * 60 * 1000;

export function tournamentWechatScheduleRemark(startsAt: Date) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(startsAt);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value || '';
    return `${part('month')}月${part('day')}日${part('hour')}:${part('minute')}开赛，请提前准备`;
}

export function tournamentReminderCandidates(now: Date): Prisma.LiveTournamentEntryWhereInput {
    return {
        activeMemberId: { not: null },
        status: { in: ['BOOKED', 'QUEUED'] },
        preMatchReminderAt: null,
        firstRoundStartedAt: null,
        usedAt: null,
        tournament: { status: 'PUBLISHED' },
        day: { startsAt: { gt: now, lte: new Date(now.getTime() + HOUR_MS) } },
    };
}

export async function recordTournamentReminder(tx: Prisma.TransactionClient, entryId: number, now: Date) {
    const candidate = await tx.liveTournamentEntry.findUnique({ where: { id: entryId }, select: { orderId: true } });
    if (!candidate) return null;
    await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${candidate.orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: candidate.orderId }, select: { status: true } });
    if (!order || order.status === 'REFUNDED' || order.status === 'CANCELLED') return null;
    const eligibility = tournamentReminderCandidates(now);
    const claimed = await tx.liveTournamentEntry.updateMany({
        where: { id: entryId, ...eligibility },
        data: { preMatchReminderAt: now },
    });
    if (!claimed.count) return null;
    const entry = await tx.liveTournamentEntry.findUniqueOrThrow({
        where: { id: entryId }, include: { day: true, tournament: { select: { title: true } } },
    });
    const startsAt = entry.day!.startsAt.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const content = `你预约的直播挑战赛将在 ${startsAt}（北京时间）开始，请提前准备登记的游戏账号。`;
    const notification = await tx.userNotification.create({
        data: {
            userId: entry.memberId,
            type: 'ORDER_PROGRESS',
            title: `赛前提醒 · ${entry.tournament.title}`.slice(0, 120),
            content,
            payload: { orderId: entry.orderId, page: `/pages/live-tournament/index?orderId=${entry.orderId}` },
        },
    });
    return {
        orderId: entry.orderId,
        notificationId: notification.id,
        content,
        wechatContent: tournamentWechatScheduleRemark(entry.day!.startsAt),
    };
}
