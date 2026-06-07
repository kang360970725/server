/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

function round2(n: any): number {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const outDirArg = args.find((a) => a.startsWith('--outDir='));
  const outDir = outDirArg ? String(outDirArg.split('=')[1]) : 'scripts/output';
  return { outDir };
}

async function main() {
  const prisma = new PrismaClient();
  const { outDir } = parseArgs();
  const runTag = new Date().toISOString().replace(/[:.]/g, '-');

  try {
    const [accounts, txs, holds] = await Promise.all([
      prisma.walletAccount.findMany({
        select: { userId: true, availableBalance: true, frozenBalance: true, depositBalance: true },
      }),
      prisma.walletTransaction.findMany({
        select: {
          id: true,
          userId: true,
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
      prisma.walletHold.findMany({
        select: { id: true, userId: true, earningTxId: true, status: true, amount: true, unlockAt: true },
      }),
    ]);

    const txById = new Map<number, any>(txs.map((t) => [Number(t.id), t]));
    const holdByTx = new Map<number, any>(holds.map((h) => [Number(h.earningTxId), h]));

    const withdrawReserveLegacy = txs.filter(
      (t) => t.bizType === 'WITHDRAW_RESERVE' && t.sourceType === 'WITHDRAWAL_REQUEST' && Number(t.sourceId) === 0,
    );
    const withdrawReserveDraft = txs.filter((t) => String(t.sourceType || '').startsWith('WITHDRAWAL_REQUEST_DRAFT:'));

    const frozenTxWithoutHold = txs.filter((t) => {
      const hasRelevantBiz =
        String(t.bizType || '').startsWith('SETTLEMENT_EARNING') ||
        t.bizType === 'SETTLEMENT_BOMB_LOSS' ||
        t.bizType === 'WITHDRAW_RESERVE';
      return t.status === 'FROZEN' && hasRelevantBiz && !holdByTx.has(Number(t.id));
    });

    const availableTxWithFrozenHold = txs.filter((t) => {
      const hold = holdByTx.get(Number(t.id));
      return t.status === 'AVAILABLE' && hold && hold.status === 'FROZEN';
    });

    const holdMismatch = holds.filter((h) => {
      const tx = txById.get(Number(h.earningTxId));
      if (!tx) return true;
      if (h.status === 'FROZEN' && tx.status === 'AVAILABLE') return true;
      if ((h.status === 'RELEASED' || h.status === 'CANCELLED') && tx.status === 'FROZEN') return true;
      return false;
    });

    const negativeAccounts = accounts.filter((a) => Number(a.availableBalance ?? 0) < 0 || Number(a.frozenBalance ?? 0) < 0);
    const negativeBalanceExposure = round2(
      accounts.reduce((sum, a) => {
        const available = Number(a.availableBalance ?? 0);
        const frozen = Number(a.frozenBalance ?? 0);
        return sum + Math.max(0, -available) + Math.max(0, -frozen);
      }, 0),
    );

    const summary = {
      runAt: new Date().toISOString(),
      databaseUrl: process.env.DATABASE_URL || null,
      usersInAccounts: accounts.length,
      transactions: txs.length,
      holds: holds.length,
      withdrawReserveLegacyCount: withdrawReserveLegacy.length,
      withdrawReserveDraftCount: withdrawReserveDraft.length,
      frozenTxWithoutHoldCount: frozenTxWithoutHold.length,
      availableTxWithFrozenHoldCount: availableTxWithFrozenHold.length,
      holdMismatchCount: holdMismatch.length,
      negativeAccountCount: negativeAccounts.length,
      negativeBalanceExposure,
    };

    const outBase = path.resolve(process.cwd(), outDir);
    fs.mkdirSync(outBase, { recursive: true });
    const summaryPath = path.join(outBase, `wallet-anomalies-${runTag}.summary.json`);
    fs.writeFileSync(
      summaryPath,
      JSON.stringify(
        {
          ...summary,
          withdrawReserveLegacy: withdrawReserveLegacy.slice(0, 50),
          withdrawReserveDraft: withdrawReserveDraft.slice(0, 50),
          frozenTxWithoutHold: frozenTxWithoutHold.slice(0, 50),
          availableTxWithFrozenHold: availableTxWithFrozenHold.slice(0, 50),
          holdMismatch: holdMismatch.slice(0, 50),
          negativeAccounts: negativeAccounts.slice(0, 50),
        },
        null,
        2,
      ),
      'utf8',
    );

    console.log('[wallet-anomalies-audit] summary:', summaryPath);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('[wallet-anomalies-audit] failed:', e);
  process.exit(1);
});
