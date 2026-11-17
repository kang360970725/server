import { Prisma, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const SOURCE = 'LOCAL_TOURNAMENT_DEMO';
const TOURNAMENT_ID = 1;
const PRIMARY_ENTRY_ID = 141;
// The preserved whitelist ticket is part of the requested 30-player test roster.
const DEMO_COUNT = 29;

function shanghai(value: string) {
    return new Date(`${value}+08:00`);
}

function assertLocalClone() {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new Error('DATABASE_URL is missing');
    const url = new URL(raw);
    if (url.protocol !== 'mysql:' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.pathname !== '/bluecat_prodclone' || url.searchParams.has('socket')) {
        throw new Error(`Refusing to seed unsafe database: ${url.hostname}${url.pathname}`);
    }
}

async function main() {
    assertLocalClone();
    if (!process.argv.includes('--apply')) {
        console.log('Dry run only. Re-run with --apply to seed local bluecat_prodclone.');
        return;
    }

    const result = await prisma.$transaction(async tx => {
        const tournament = await tx.liveTournament.findUnique({
            where: { id: TOURNAMENT_ID },
            include: { days: { orderBy: { startsAt: 'asc' } } },
        });
        if (!tournament || tournament.status !== 'PUBLISHED') {
            throw new Error('Tournament 1 must exist and remain PUBLISHED');
        }

        const primary = await tx.liveTournamentEntry.findUnique({ where: { id: PRIMARY_ENTRY_ID } });
        if (!primary || primary.tournamentId !== TOURNAMENT_ID || primary.memberId !== 20) {
            throw new Error('Primary whitelist ticket is missing');
        }

        const seededOrders = await tx.order.findMany({ where: { orderSource: SOURCE }, select: { id: true } });
        const seededOrderIds = seededOrders.map(order => order.id);
        if (seededOrderIds.length) {
            const seededEntries = await tx.liveTournamentEntry.findMany({
                where: { orderId: { in: seededOrderIds } }, select: { id: true },
            });
            const seededEntryIds = seededEntries.map(entry => entry.id);
            if (seededEntryIds.length) {
                await tx.liveTournamentRound.deleteMany({ where: { entryId: { in: seededEntryIds } } });
                await tx.liveTournamentEntry.deleteMany({ where: { id: { in: seededEntryIds } } });
            }
            await tx.order.deleteMany({ where: { id: { in: seededOrderIds } } });
        }

        await tx.liveTournamentRound.deleteMany({ where: { entryId: PRIMARY_ENTRY_ID } });

        const schedule = [
            { date: '2026-11-17', start: '2026-11-17T20:00:00', end: '2026-11-17T23:00:00', capacity: 10 },
            { date: '2026-11-18', start: '2026-11-18T20:00:00', end: '2026-11-18T23:00:00', capacity: 10 },
            { date: '2026-11-19', start: '2026-11-19T20:00:00', end: '2026-11-19T23:00:00', capacity: 10 },
        ];
        const days = [...tournament.days];
        for (const extra of days.slice(3)) {
            if (await tx.liveTournamentEntry.count({ where: { dayId: extra.id } })) {
                throw new Error(`Cannot remove day ${extra.id}: it contains non-demo entries`);
            }
            await tx.liveTournamentQuota.deleteMany({ where: { dayId: extra.id } });
            await tx.liveTournamentDay.delete({ where: { id: extra.id } });
        }
        while (days.length < 3) {
            const slot = schedule[days.length];
            days.push(await tx.liveTournamentDay.create({ data: {
                tournamentId: TOURNAMENT_ID,
                date: new Date(`${slot.date}T00:00:00.000Z`),
                startsAt: shanghai(slot.start), endsAt: shanghai(slot.end), capacity: slot.capacity,
            } }));
        }

        const now = new Date();
        for (let index = 0; index < 3; index += 1) {
            const slot = schedule[index];
            await tx.liveTournamentQuota.deleteMany({ where: { dayId: days[index].id } });
            days[index] = await tx.liveTournamentDay.update({
                where: { id: days[index].id },
                data: {
                    date: new Date(`${slot.date}T00:00:00.000Z`),
                    startsAt: shanghai(slot.start), endsAt: shanghai(slot.end),
                    capacity: slot.capacity, rosterPublishedAt: now,
                },
            });
        }

        const providerSets = [[4, 5, 9], [14, 17, 18], [4, 14, 18]];
        await tx.liveTournamentQuota.createMany({ data: days.slice(0, 3).flatMap((day, dayIndex) =>
            providerSets[dayIndex].map(providerId => ({ dayId: day.id, providerId, minimum: 2, maximum: 4 })),
        ) });

        await tx.liveTournament.update({
            where: { id: TOURNAMENT_ID },
            data: {
                startsAt: shanghai(schedule[0].start), endsAt: shanghai(schedule[2].end),
                bookingOpenedAt: tournament.bookingOpenedAt ?? now,
                leaderboardLockedAt: null, leaderboardSnapshot: Prisma.DbNull,
            },
        });

        await tx.liveTournamentEntry.update({
            where: { id: PRIMARY_ENTRY_ID },
            data: {
                dayId: days[0].id, status: 'QUEUED', appearanceSequence: null, queuePosition: 1,
                checkedInAt: now, onStageAt: null, firstRoundStartedAt: null, usedAt: null,
                providerId: null, drawnAt: null, rescheduledAt: null,
            },
        });

        const occupiedMembers = await tx.liveTournamentEntry.findMany({
            where: { tournamentId: TOURNAMENT_ID }, select: { memberId: true },
        });
        const members = await tx.user.findMany({
            where: {
                userType: 'REGISTERED_USER', status: 'ACTIVE',
                id: { notIn: occupiedMembers.map(entry => entry.memberId) },
                memberProfile: { isNot: null },
            },
            orderBy: { id: 'asc' }, take: DEMO_COUNT,
            select: { id: true, phone: true },
        });
        if (members.length !== DEMO_COUNT) throw new Error(`Need ${DEMO_COUNT} active registered members, got ${members.length}`);

        const templateOrder = await tx.order.findUnique({ where: { id: primary.orderId } });
        if (!templateOrder) throw new Error('Primary tournament order is missing');
        const aliases = [
            '霜刃', '北境猎手', '蓝焰', '星港', '破晓', '逐风', '赤曜', '白夜', '苍穹', '孤城',
            '流火', '惊雷', '长歌', '天枢', '云策', '墨羽', '凌光', '千刃', '星野', '烬川',
            '寒江', '曜灵', '青锋', '夜阑', '玄策', '临渊', '风眠', '赤霄', '逐月', '无相',
        ];
        const createdEntries: Array<{ id: number; orderId: number; dayId: number; queuePosition: number }> = [];

        for (let index = 0; index < DEMO_COUNT; index += 1) {
            const member = members[index];
            const dayIndex = index < 9 ? 0 : index < 19 ? 1 : 2;
            const queuePosition = dayIndex === 0 ? index + 2 : dayIndex === 1 ? index - 8 : index - 18;
            const serial = String(index + 1).padStart(2, '0');
            const order = await tx.order.create({ data: {
                autoSerial: `LT-DEMO-20261117-${serial}`,
                receivableAmount: 68, paidAmount: 68, settlementBaseAmount: 68,
                orderTime: now, paymentTime: now, openedAt: now, orderQuantity: 1,
                projectId: tournament.gameProjectId, projectSnapshot: templateOrder.projectSnapshot,
                customerGameId: `LTG${String(index + 1).padStart(6, '0')}`,
                customerIdentifierType: 'GAME_ID',
                customerOriginalIdentifier: `LTG${String(index + 1).padStart(6, '0')}`,
                customerUserId: member.id, orderSource: SOURCE,
                status: 'WAIT_ASSIGN', isPaid: true, payStatus: 'SUCCESS', isTestPayment: true,
                originalAmount: 68, finalPayableAmount: 68, discountType: 'NONE',
            } });
            const entry = await tx.liveTournamentEntry.create({ data: {
                tournamentId: TOURNAMENT_ID, orderId: order.id, memberId: member.id, activeMemberId: member.id,
                dayId: days[dayIndex].id, status: 'QUEUED', appearanceSequence: null, queuePosition,
                contactName: `测试选手${serial}`, contactPhone: member.phone,
                gameAccountId: `90020261117${String(index + 1).padStart(4, '0')}`,
                gameNickname: `蓝猫_${aliases[index]}`,
                gameRank: ['黄金', '铂金', '钻石', '大师'][index % 4], competitionName: aliases[index],
                checkedInAt: now,
            } });
            createdEntries.push({ id: entry.id, orderId: order.id, dayId: entry.dayId!, queuePosition });
        }

        return {
            tournamentId: TOURNAMENT_ID, primaryEntryId: PRIMARY_ENTRY_ID,
            demoEntries: createdEntries.length, totalReadyEntries: createdEntries.length + 1,
            days: days.slice(0, 3).map((day, index) => ({
                id: day.id, startsAt: schedule[index].start.replace('T', ' '),
                demoEntries: index === 0 ? 9 : 10, totalEntries: 10,
                providers: providerSets[index],
            })),
        };
    }, { maxWait: 10_000, timeout: 60_000 });

    console.log(JSON.stringify(result, null, 2));
}

main()
    .catch(error => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
