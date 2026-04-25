/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

type TxLite = {
  id: number;
  userId: number;
  createdAt: Date;
  bizType: string;
  status: string;
  direction: string;
  amount: number;
  sourceType: string;
  sourceId: number;
  orderId: number | null;
  settlementId: number | null;
  dispatchId: number | null;
};

type UserAudit = {
  userId: number;
  txCount: number;
  replayAvailable: number;
  replayFrozen: number;
  replayTotal: number;
  accountAvailable: number;
  accountFrozen: number;
  accountTotal: number;
  diffAvailable: number;
  diffFrozen: number;
  diffTotal: number;
  overpaidAmount: number;
  underpaidAmount: number;
  payoutTotal: number;
  settlementTotal: number;
  bombLossTotal: number;
  refundReversalNet: number;
  depositAdjustNet: number;
  offlineFeeNet: number;
  hasNegativeMoment: boolean;
  lastTxAt: Date | null;
};

function round2(n: any): number {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const userIdArg = args.find((a) => a.startsWith('--userId='));
  const topArg = args.find((a) => a.startsWith('--top='));
  const outDirArg = args.find((a) => a.startsWith('--outDir='));

  const userId = userIdArg ? Number(userIdArg.split('=')[1]) : undefined;
  const top = topArg ? Number(topArg.split('=')[1]) : 30;
  const outDir = outDirArg ? String(outDirArg.split('=')[1]) : 'scripts/output';

  return {
    userId: Number.isFinite(userId as number) && (userId as number) > 0 ? Number(userId) : undefined,
    top: Number.isFinite(top) && top > 0 ? Number(top) : 30,
    outDir,
  };
}

function calcDelta(tx: TxLite) {
  const biz = String(tx.bizType || '');
  const status = String(tx.status || '');
  const direction = String(tx.direction || '');
  const amount = round2(tx.amount);

  if (status === 'REVERSED') return { da: 0, df: 0 };

  // 结算主流水会从 FROZEN 更新为 AVAILABLE，重放时始终按“冻结入账”看待
  if (
    biz === 'SETTLEMENT_EARNING' ||
    biz === 'SETTLEMENT_EARNING_BASE' ||
    biz === 'SETTLEMENT_EARNING_CARRY' ||
    biz === 'SETTLEMENT_EARNING_CS'
  ) {
    if (direction === 'IN') return { da: 0, df: amount };
    if (direction === 'OUT') return { da: 0, df: -amount };
    return { da: 0, df: 0 };
  }

  if (biz === 'SETTLEMENT_BOMB_LOSS') return { da: -amount, df: 0 };
  if (biz === 'RELEASE_FROZEN') return { da: amount, df: -amount };
  if (biz === 'WITHDRAW_RESERVE') return { da: -amount, df: amount };
  if (biz === 'WITHDRAW_RELEASE') return { da: amount, df: -amount };
  if (biz === 'WITHDRAW_PAYOUT') return { da: 0, df: -amount };

  if (biz === 'REFUND_REVERSAL' || biz === 'OFFLINE_FEE_PAYMENT' || biz === 'DEPOSIT_ADD' || biz === 'DEPOSIT_DEDUCT') {
    if (direction === 'IN') return { da: amount, df: 0 };
    if (direction === 'OUT') return { da: -amount, df: 0 };
    return { da: 0, df: 0 };
  }

  if (biz === 'SETTLEMENT_RECALC' || biz === 'SETTLEMENT_REVERSAL') {
    const sign = direction === 'OUT' ? -1 : 1;
    if (status === 'FROZEN') return { da: 0, df: round2(sign * amount) };
    if (status === 'AVAILABLE') return { da: round2(sign * amount), df: 0 };
    return { da: 0, df: 0 };
  }

  return { da: 0, df: 0 };
}

function summarizeUser(userId: number, txs: TxLite[], account: { availableBalance: any; frozenBalance: any } | null): UserAudit {
  let replayAvailable = 0;
  let replayFrozen = 0;
  let hasNegativeMoment = false;

  let payoutTotal = 0;
  let settlementTotal = 0;
  let bombLossTotal = 0;
  let refundReversalNet = 0;
  let depositAdjustNet = 0;
  let offlineFeeNet = 0;

  for (const tx of txs) {
    const { da, df } = calcDelta(tx);
    replayAvailable = round2(replayAvailable + da);
    replayFrozen = round2(replayFrozen + df);
    if (replayAvailable < -0.01 || replayFrozen < -0.01) hasNegativeMoment = true;

    const amt = round2(tx.amount);
    const sign = tx.direction === 'OUT' ? -1 : 1;

    if (
      (tx.bizType === 'SETTLEMENT_EARNING' ||
        tx.bizType === 'SETTLEMENT_EARNING_BASE' ||
        tx.bizType === 'SETTLEMENT_EARNING_CARRY' ||
        tx.bizType === 'SETTLEMENT_EARNING_CS') &&
      tx.status !== 'REVERSED'
    ) {
      settlementTotal = round2(settlementTotal + sign * amt);
    }
    if (tx.bizType === 'SETTLEMENT_BOMB_LOSS' && tx.status !== 'REVERSED') {
      bombLossTotal = round2(bombLossTotal + amt);
    }
    if (tx.bizType === 'WITHDRAW_PAYOUT' && tx.status !== 'REVERSED') {
      payoutTotal = round2(payoutTotal + amt);
    }
    if (tx.bizType === 'REFUND_REVERSAL' && tx.status !== 'REVERSED') {
      refundReversalNet = round2(refundReversalNet + sign * amt);
    }
    if ((tx.bizType === 'DEPOSIT_ADD' || tx.bizType === 'DEPOSIT_DEDUCT') && tx.status !== 'REVERSED') {
      depositAdjustNet = round2(depositAdjustNet + sign * amt);
    }
    if (tx.bizType === 'OFFLINE_FEE_PAYMENT' && tx.status !== 'REVERSED') {
      offlineFeeNet = round2(offlineFeeNet + sign * amt);
    }
  }

  const accountAvailable = round2(account?.availableBalance ?? 0);
  const accountFrozen = round2(account?.frozenBalance ?? 0);
  const accountTotal = round2(accountAvailable + accountFrozen);
  const replayTotal = round2(replayAvailable + replayFrozen);

  const diffAvailable = round2(replayAvailable - accountAvailable);
  const diffFrozen = round2(replayFrozen - accountFrozen);
  const diffTotal = round2(replayTotal - accountTotal);

  return {
    userId,
    txCount: txs.length,
    replayAvailable,
    replayFrozen,
    replayTotal,
    accountAvailable,
    accountFrozen,
    accountTotal,
    diffAvailable,
    diffFrozen,
    diffTotal,
    overpaidAmount: diffTotal < 0 ? round2(-diffTotal) : 0,
    underpaidAmount: diffTotal > 0 ? diffTotal : 0,
    payoutTotal,
    settlementTotal,
    bombLossTotal,
    refundReversalNet,
    depositAdjustNet,
    offlineFeeNet,
    hasNegativeMoment,
    lastTxAt: txs.length ? txs[txs.length - 1].createdAt : null,
  };
}

async function main() {
  const prisma = new PrismaClient();
  const { userId, top, outDir } = parseArgs();
  const runTag = new Date().toISOString().replace(/[:.]/g, '-');

  try {
    const userWhere = userId ? { userId } : undefined;

    const [accounts, txs] = await Promise.all([
      prisma.walletAccount.findMany({
        where: userId ? { userId } : undefined,
        select: { userId: true, availableBalance: true, frozenBalance: true },
      }),
      prisma.walletTransaction.findMany({
        where: userWhere,
        orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          userId: true,
          createdAt: true,
          bizType: true,
          status: true,
          direction: true,
          amount: true,
          sourceType: true,
          sourceId: true,
          orderId: true,
          settlementId: true,
          dispatchId: true,
        },
      }),
    ]);

    const accountMap = new Map<number, { availableBalance: any; frozenBalance: any }>(
      accounts.map((a) => [Number(a.userId), { availableBalance: a.availableBalance, frozenBalance: a.frozenBalance }]),
    );

    const txMap = new Map<number, TxLite[]>();
    for (const tx of txs as TxLite[]) {
      const uid = Number(tx.userId);
      const arr = txMap.get(uid) || [];
      arr.push(tx);
      txMap.set(uid, arr);
    }

    const users = new Set<number>([...Array.from(accountMap.keys()), ...Array.from(txMap.keys())]);
    const audits: UserAudit[] = [];
    for (const uid of users) {
      const txList = txMap.get(uid) || [];
      const acc = accountMap.get(uid) || null;
      audits.push(summarizeUser(uid, txList, acc));
    }

    const overpaidUsers = audits
      .filter((x) => x.overpaidAmount > 0.01)
      .sort((a, b) => b.overpaidAmount - a.overpaidAmount);
    const underpaidUsers = audits
      .filter((x) => x.underpaidAmount > 0.01)
      .sort((a, b) => b.underpaidAmount - a.underpaidAmount);

    const outBase = path.resolve(process.cwd(), outDir);
    fs.mkdirSync(outBase, { recursive: true });
    const summaryPath = path.join(outBase, `wallet-overpay-audit-${runTag}.summary.json`);
    const detailPath = path.join(outBase, `wallet-overpay-audit-${runTag}.overpaid-detail.json`);
    const csvPath = path.join(outBase, `wallet-overpay-audit-${runTag}.overpaid.csv`);

    const overpaidTop = overpaidUsers.slice(0, top);
    const underpaidTop = underpaidUsers.slice(0, top);

    // 为疑似多发用户提取最近可追溯流水
    const overpaidDetail = overpaidTop.map((u) => {
      const all = txMap.get(u.userId) || [];
      const recent = all.slice(Math.max(0, all.length - 120));
      return {
        ...u,
        recentTx: recent.map((t) => ({
          id: t.id,
          createdAt: t.createdAt,
          bizType: t.bizType,
          status: t.status,
          direction: t.direction,
          amount: round2(t.amount),
          sourceType: t.sourceType,
          sourceId: t.sourceId,
          orderId: t.orderId,
          dispatchId: t.dispatchId,
          settlementId: t.settlementId,
        })),
      };
    });

    const summary = {
      runAt: new Date().toISOString(),
      databaseUrl: process.env.DATABASE_URL || null,
      scopedUserId: userId ?? null,
      usersInAccounts: accounts.length,
      usersInTransactions: txMap.size,
      auditedUsers: audits.length,
      overpaidUserCount: overpaidUsers.length,
      underpaidUserCount: underpaidUsers.length,
      overpaidTotalAmount: round2(overpaidUsers.reduce((s, x) => s + x.overpaidAmount, 0)),
      underpaidTotalAmount: round2(underpaidUsers.reduce((s, x) => s + x.underpaidAmount, 0)),
      overpaidTop,
      underpaidTop,
    };

    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    fs.writeFileSync(detailPath, JSON.stringify(overpaidDetail, null, 2), 'utf8');

    const csvHeader =
      'userId,txCount,overpaidAmount,diffTotal,diffAvailable,diffFrozen,accountTotal,replayTotal,accountAvailable,accountFrozen,replayAvailable,replayFrozen,payoutTotal,settlementTotal,bombLossTotal,refundReversalNet,depositAdjustNet,offlineFeeNet,hasNegativeMoment,lastTxAt';
    const csvRows = overpaidUsers.map((u) =>
      [
        u.userId,
        u.txCount,
        u.overpaidAmount,
        u.diffTotal,
        u.diffAvailable,
        u.diffFrozen,
        u.accountTotal,
        u.replayTotal,
        u.accountAvailable,
        u.accountFrozen,
        u.replayAvailable,
        u.replayFrozen,
        u.payoutTotal,
        u.settlementTotal,
        u.bombLossTotal,
        u.refundReversalNet,
        u.depositAdjustNet,
        u.offlineFeeNet,
        u.hasNegativeMoment ? 'true' : 'false',
        u.lastTxAt ? new Date(u.lastTxAt).toISOString() : '',
      ].join(','),
    );
    fs.writeFileSync(csvPath, `${csvHeader}\n${csvRows.join('\n')}\n`, 'utf8');

    console.log('[wallet-overpay-audit] summary:', summaryPath);
    console.log('[wallet-overpay-audit] detail:', detailPath);
    console.log('[wallet-overpay-audit] csv:', csvPath);
    console.log(
      JSON.stringify(
        {
          overpaidUserCount: summary.overpaidUserCount,
          overpaidTotalAmount: summary.overpaidTotalAmount,
          topOverpaid: summary.overpaidTop.slice(0, Math.min(10, summary.overpaidTop.length)),
          underpaidUserCount: summary.underpaidUserCount,
          underpaidTotalAmount: summary.underpaidTotalAmount,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('[wallet-overpay-audit] failed:', e);
  process.exit(1);
});
