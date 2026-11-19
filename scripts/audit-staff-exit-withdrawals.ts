import { Prisma, PrismaClient } from '@prisma/client';
import { getStaffExitOrderReserve } from '../src/wallet/staff-exit-order-reserve';
import { inspectWalletFundingTx } from '../src/wallet/wallet-funding.util';
import { round2 } from '../src/utils/money/format';

const db = new PrismaClient();
const activeStatuses = new Set(['PENDING_REVIEW', 'APPROVED', 'PAYING', 'FAILED']);

async function main() {
    const result = await db.$transaction(async (tx) => {
        const users = await tx.user.findMany({
            where: {
                userType: 'STAFF',
                staffEmploymentStatus: { in: ['EXITED', 'BLACKLISTED'] },
                walletWithdrawalRequests: { some: {} },
            },
            orderBy: { id: 'asc' },
            select: {
                id: true, staffEmploymentStatus: true, staffExitedAt: true,
                walletAccount: { select: {
                    availableBalance: true, earningFrozenBalance: true, withdrawFrozenBalance: true, depositBalance: true,
                } },
                walletWithdrawalRequests: {
                    orderBy: { id: 'asc' },
                    select: { id: true, amount: true, status: true, transferStatus: true, createdAt: true, reviewedAt: true, transferFinishedAt: true },
                },
            },
        });

        const rows = [];
        for (const user of users) {
            const { walletAccount, walletWithdrawalRequests: requests, ...staff } = user;
            const reserve = await getStaffExitOrderReserve(tx, user.id);
            const active = requests.filter((request) => activeStatuses.has(request.status));
            const paid = requests.filter(({ status }) => status === 'PAID');
            const paidSinceExit = paid.filter((request) => user.staffExitedAt &&
                (request.transferFinishedAt ?? request.reviewedAt ?? request.createdAt) >= user.staffExitedAt);
            const positiveFunds = walletAccount && [
                walletAccount.availableBalance, walletAccount.earningFrozenBalance, walletAccount.withdrawFrozenBalance,
            ].some((value) => Number(value) > 0);
            const fullyWithdrawn = paid.length > 0 && active.length === 0 && !positiveFunds;
            const remainingAssets = round2(Number(walletAccount?.availableBalance ?? 0) +
                Number(walletAccount?.earningFrozenBalance ?? 0));
            let fundingIssue: string | null = null;
            if (!fullyWithdrawn && active.length) {
                try {
                    await inspectWalletFundingTx(tx, user.id);
                } catch (error) {
                    if (!(error instanceof Error) || error.name !== 'BadRequestException') throw error;
                    fundingIssue = error.message;
                }
            }
            rows.push({
                ...staff, walletAccount, fullyWithdrawn, remainingAssets, fundingIssue,
                paidRequestCount: paid.length,
                paidSinceExitAmount: round2(paidSinceExit.reduce((sum, request) => sum + request.amount, 0)),
                activeRequests: active,
                reserve,
                uncoveredReserve: round2(Math.max(0, reserve.amount - Math.max(0, remainingAssets))),
            });
        }
        return rows;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000 });

    console.log(JSON.stringify({
        auditedAt: new Date().toISOString(),
        usersAudited: result.length,
        fullyWithdrawn: result.filter((row) => row.fullyWithdrawn).length,
        withActiveWithdrawals: result.filter((row) => row.activeRequests.length > 0).length,
        withUnsettledBombLoss: result.filter((row) => row.reserve.items.length > 0).length,
        activeWithUnsettledBombLoss: result.filter((row) => row.activeRequests.length > 0 && row.reserve.items.length > 0).length,
        activeWithFundingIssue: result.filter((row) => row.fundingIssue).length,
        rows: result,
    }, null, 2));
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}).finally(() => db.$disconnect());
