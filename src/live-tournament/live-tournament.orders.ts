import { canMemberEnterTournament, tournamentMemberEligibilitySelect } from './live-tournament.eligibility';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lockTournamentScoring } from './live-tournament.scores';
import { tournamentRoundPoints } from './live-tournament.rules';

type Transaction = Prisma.TransactionClient;

async function lockTournament(tx: Transaction, tournamentId: number) {
    await tx.$queryRaw`SELECT id FROM LiveTournament WHERE id = ${tournamentId} FOR UPDATE`;
}

export async function prepareTournamentTicket(tx: Transaction, input: {
    projectId: number;
    memberId: number | null;
    quantity: number;
    admin: boolean;
    gifted: boolean;
    paidOrOnline: boolean;
    manualDispatch: boolean;
}) {
    if (!tx.liveTournament) return null;
    const tournament = await tx.liveTournament.findFirst({
        where: { gameProjectId: input.projectId },
        orderBy: [{ salesStartAt: 'desc' }, { id: 'desc' }],
    });
    if (!tournament) return null;

    await lockTournament(tx, tournament.id);
    // Locking reads see tickets committed while this transaction waited for the event.
    const active = await tx.$queryRaw<{ activeMemberId: number }[]>`
        SELECT activeMemberId FROM LiveTournamentEntry
        WHERE tournamentId = ${tournament.id} AND isRevival = false AND activeMemberId IS NOT NULL FOR UPDATE
    `;
    const now = new Date();
    if (tournament.status !== 'PUBLISHED' || now < tournament.salesStartAt || now >= tournament.salesEndAt) {
        throw new BadRequestException('赛事门票当前不可售卖');
    }
    if (!input.admin) throw new BadRequestException('赛事门票仅支持客服售卖');
    if (!input.memberId) throw new BadRequestException('购买赛事门票前，请先绑定参赛会员');
    const member = await tx.user.findUnique({ where: { id: input.memberId }, select: tournamentMemberEligibilitySelect });
    if (!member) throw new BadRequestException('绑定会员不存在');
    if (!canMemberEnterTournament(member)) throw new BadRequestException('店内认证服务者不可购买本赛事门票或参赛，请更换会员');
    if (input.quantity !== 1) throw new BadRequestException('赛事门票每单限购一张');
    if (input.gifted) throw new BadRequestException('赛事门票不支持赠送订单');
    if (input.manualDispatch) throw new BadRequestException('赛事门票无需派单，服务者由直播转盘分配');
    if (!input.paidOrOnline) throw new BadRequestException('请使用线下收款并确认已收款后售票');
    if (active.filter(ticket => ticket.activeMemberId === input.memberId).length >= (tournament.memberTicketLimit ?? 1)) {
        throw new BadRequestException('该会员已购买或正在支付本赛事门票');
    }
    if (active.length >= Math.min(70, tournament.ticketLimit)) throw new BadRequestException('赛事门票已售罄');
    return tournament.id;
}

export async function activateTournamentTicket(tx: Transaction, orderId: number) {
    const ticket = await tx.liveTournamentEntry?.findFirst({ where: { orderId, attemptNumber: 1 } });
    if (!ticket) return;
    await lockTournament(tx, ticket.tournamentId);
    const updated = await tx.liveTournamentEntry.updateMany({
        where: { orderId, status: 'PENDING_PAYMENT' },
        data: { status: 'UNBOOKED' },
    });
    if (!updated.count) return;
    const paid = await tx.$queryRaw<{ id: number }[]>`
        SELECT id FROM LiveTournamentEntry
        WHERE tournamentId = ${ticket.tournamentId} AND isRevival = false AND activeMemberId IS NOT NULL
          AND status NOT IN ('PENDING_PAYMENT', 'VOID') FOR UPDATE
    `;
    const tournament = await tx.liveTournament.findUniqueOrThrow({ where: { id: ticket.tournamentId } });
    if (paid.length >= tournament.bookingThreshold) {
        await tx.liveTournament.updateMany({
            where: { id: tournament.id, bookingOpenedAt: null },
            data: { bookingOpenedAt: new Date() },
        });
    }
}

export async function voidTournamentTicket(tx: Transaction, orderId: number) {
    await tx.liveTournamentEntry?.updateMany({
        where: { orderId, status: { not: 'VOID' } },
        data: { status: 'VOID', activeMemberId: null, dayId: null, queuePosition: null },
    });
}

export async function lockTournamentTicket(tx: Transaction, orderId: number) {
    if (!tx.liveTournamentEntry) return null;
    const rows = await tx.$queryRaw<{ id: number; usedAt: Date | null; status: string; firstRoundStartedAt: Date | null }[]>`
        SELECT id, usedAt, status, firstRoundStartedAt FROM LiveTournamentEntry
        WHERE orderId = ${orderId} AND attemptNumber = 1 FOR UPDATE
    `;
    return rows[0] ?? null;
}

export async function saveTournamentRound(tx: Transaction, input: {
    orderId: number;
    entryId?: number;
    roundNumber: number;
    kills: number;
    firstKillElapsedMs: number | null;
    firstKillAt: Date | null;
    forfeited?: boolean;
}) {
    if (![1, 2].includes(input.roundNumber) || !Number.isSafeInteger(input.kills) || input.kills < 0) {
        throw new BadRequestException('请输入有效局数和击杀数');
    }
    if (input.kills === 0
        ? input.firstKillElapsedMs !== null || input.firstKillAt !== null
        : !Number.isSafeInteger(input.firstKillElapsedMs) || input.firstKillElapsedMs! < 0 ||
          !input.firstKillAt || !Number.isFinite(input.firstKillAt.getTime())) {
        throw new BadRequestException('请核对首杀时间和击杀数');
    }
    const entry = input.entryId
        ? await tx.liveTournamentEntry.findFirst({
            where: { id: input.entryId, orderId: input.orderId }, select: { id: true, tournamentId: true },
        })
        : await tx.liveTournamentEntry.findFirst({
            where: { orderId: input.orderId, status: { not: 'VOID' } },
            orderBy: { attemptNumber: 'desc' }, select: { id: true, tournamentId: true },
        });
    if (!entry) throw new BadRequestException('赛事门票不存在');
    await lockTournamentScoring(tx, entry.tournamentId);
    await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${input.orderId} FOR UPDATE`;
    const locked = await tx.$queryRaw<{ id: number; usedAt: Date | null; status: string; firstRoundStartedAt: Date | null }[]>`
        SELECT id, usedAt, status, firstRoundStartedAt FROM LiveTournamentEntry WHERE id = ${entry.id} FOR UPDATE
    `;
    const ticket = locked[0] ?? null;
    if (!ticket || !['ON_STAGE', 'SCORING', 'FINISHED'].includes(ticket.status)) {
        throw new BadRequestException('当前参赛状态不可录分');
    }
    if (!ticket.firstRoundStartedAt) throw new BadRequestException('请先记录首局开打');
    const order = await tx.order.findUniqueOrThrow({ where: { id: input.orderId }, select: { status: true } });
    if (order.status === 'REFUNDED' || order.status === 'CANCELLED') {
        throw new BadRequestException('订单已退款或取消');
    }
    if (input.forfeited) {
        const first = await tx.liveTournamentRound.findUnique({ where: { entryId_roundNumber: { entryId: ticket.id, roundNumber: 1 } } });
        if (input.roundNumber !== 2 || input.kills !== 0 || first?.kills == null || ticket.status === 'ON_STAGE') {
            throw new BadRequestException('首局完成并结束本场后，才可登记第二局弃权');
        }
    }
    const score = {
        kills: input.kills,
        firstKillElapsedMs: input.firstKillElapsedMs,
        firstKillAt: input.firstKillAt,
        forfeited: input.forfeited === true,
    };
    const round = await tx.liveTournamentRound.upsert({
        where: { entryId_roundNumber: { entryId: ticket.id, roundNumber: input.roundNumber } },
        create: { entryId: ticket.id, roundNumber: input.roundNumber, ...score },
        update: score,
    });
    if (!ticket.usedAt) {
        await tx.liveTournamentEntry.update({ where: { id: ticket.id }, data: { usedAt: new Date() } });
    }
    return { ...round, points: tournamentRoundPoints(round.kills!) };
}
