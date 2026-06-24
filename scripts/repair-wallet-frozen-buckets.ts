/* eslint-disable no-console */
import { PrismaClient, WalletHoldStatus, WithdrawalStatus } from '@prisma/client';

function round2(value: any) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const userIdArg = args.find((item) => item.startsWith('--userId='));
  const limitArg = args.find((item) => item.startsWith('--limit='));
  const includeDeficitUsers = args.includes('--includeDeficitUsers');

  const userId = userIdArg ? Number(userIdArg.split('=')[1]) : undefined;
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 200;

  return {
    apply,
    includeDeficitUsers,
    userId: Number.isFinite(userId as number) && Number(userId) > 0 ? Number(userId) : undefined,
    limit: Number.isFinite(limit) && limit > 0 ? Number(limit) : 200,
  };
}

async function main() {
  const prisma = new PrismaClient();
  const { apply, includeDeficitUsers, userId, limit } = parseArgs();

  try {
    const accounts = await prisma.walletAccount.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { userId: 'asc' },
      take: userId ? undefined : limit,
      select: {
        userId: true,
        availableBalance: true,
        frozenBalance: true,
        earningFrozenBalance: true,
        withdrawFrozenBalance: true,
        depositBalance: true,
        user: {
          select: {
            phone: true,
            name: true,
            userType: true,
            status: true,
            canWithdraw: true,
          },
        },
      },
    });

    const activeWithdrawStatuses = [
      WithdrawalStatus.PENDING_REVIEW,
      WithdrawalStatus.APPROVED,
      WithdrawalStatus.PAYING,
      WithdrawalStatus.FAILED,
    ];

    const preview: any[] = [];

    for (const account of accounts) {
      const [holdAgg, withdrawAgg, negativeAgg] = await Promise.all([
        prisma.walletHold.aggregate({
          where: { userId: account.userId, status: WalletHoldStatus.FROZEN },
          _sum: { amount: true },
        }),
        prisma.walletWithdrawalRequest.aggregate({
          where: { userId: account.userId, status: { in: activeWithdrawStatuses } },
          _sum: { amount: true },
        }),
        prisma.walletTransaction.aggregate({
          where: { userId: account.userId, frozenAfter: { lt: 0 } as any },
          _count: true,
          _min: { frozenAfter: true },
        }),
      ]);

      const currentAvailable = round2(account.availableBalance);
      const currentFrozen = round2(account.frozenBalance);
      const currentEarningFrozen = round2((account as any).earningFrozenBalance);
      const currentWithdrawFrozen = round2((account as any).withdrawFrozenBalance);
      const currentTotal = round2(currentAvailable + currentFrozen);
      const expectedEarningFrozen = round2(holdAgg._sum.amount);
      const expectedWithdrawFrozen = round2(withdrawAgg._sum.amount);
      const expectedFrozen = round2(expectedEarningFrozen + expectedWithdrawFrozen);
      const expectedAvailable = round2(currentTotal - expectedFrozen);
      const deficitAmount = expectedAvailable < 0 ? round2(Math.abs(expectedAvailable)) : 0;

      const item = {
        userId: account.userId,
        phone: account.user.phone,
        name: account.user.name,
        userType: account.user.userType,
        status: account.user.status,
        canWithdraw: account.user.canWithdraw,
        currentAvailable,
        currentFrozen,
        currentEarningFrozen,
        currentWithdrawFrozen,
        expectedAvailable,
        expectedFrozen,
        expectedEarningFrozen,
        expectedWithdrawFrozen,
        deficitAmount,
        negativeFrozenSnapshotCount: Number(negativeAgg._count || 0),
        minFrozenAfter: round2(negativeAgg._min.frozenAfter),
      };

      const hasIssue =
        deficitAmount > 0 ||
        Math.abs(item.expectedAvailable - item.currentAvailable) > 0.009 ||
        Math.abs(item.expectedFrozen - item.currentFrozen) > 0.009 ||
        Math.abs(item.expectedEarningFrozen - item.currentEarningFrozen) > 0.009 ||
        Math.abs(item.expectedWithdrawFrozen - item.currentWithdrawFrozen) > 0.009 ||
        item.currentAvailable < 0 ||
        item.currentFrozen < 0 ||
        item.currentEarningFrozen < 0 ||
        item.currentWithdrawFrozen < 0;

      if (hasIssue) {
        preview.push(item);
      }
    }

    if (!apply) {
      console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        scannedUsers: accounts.length,
        issueUsers: preview.length,
        items: includeDeficitUsers ? preview : preview.slice(0, 200),
      }, null, 2));
      return;
    }

    let repairedCount = 0;
    for (const item of preview) {
      if (item.deficitAmount > 0) continue;
      await prisma.walletAccount.update({
        where: { userId: item.userId },
        data: {
          availableBalance: item.expectedAvailable,
          frozenBalance: item.expectedFrozen,
          earningFrozenBalance: item.expectedEarningFrozen,
          withdrawFrozenBalance: item.expectedWithdrawFrozen,
        } as any,
      });
      repairedCount += 1;
    }

    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      scannedUsers: accounts.length,
      issueUsers: preview.length,
      repairedCount,
      blockedCount: preview.filter((item) => item.deficitAmount > 0).length,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[repair-wallet-frozen-buckets] failed:', error);
  process.exit(1);
});
