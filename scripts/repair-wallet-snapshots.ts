/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 历史修复脚本：修复“解冻时覆盖原冻结收益快照”导致的污染数据
 *
 * 识别规则（高置信）：
 * - 收益流水：sourceType='ORDER_SETTLEMENT' 且 bizType 属于结算收益类
 * - 对应存在唯一解冻流水：sourceType='WALLET_HOLD_RELEASE' 且 sourceId=earningTx.id
 * - earningTx 快照 与 releaseTx 快照 完全相同（极大概率是被解冻流程覆盖）
 *
 * 修复动作：
 * - 将 earningTx.availableAfter / earningTx.frozenAfter 置空
 * - 前端/报表可回退到“按当前余额锚点倒推”逻辑，避免直接展示错误历史基数
 *
 * 使用：
 * 1) 单用户 dry-run：
 *    npx ts-node scripts/repair-wallet-snapshots.ts --userId=123
 * 2) 单用户 apply：
 *    npx ts-node scripts/repair-wallet-snapshots.ts --apply --userId=123
 * 3) 批量 dry-run（全用户）：
 *    npx ts-node scripts/repair-wallet-snapshots.ts --batchSize=1000
 * 4) 批量 apply（全用户）：
 *    npx ts-node scripts/repair-wallet-snapshots.ts --apply --batchSize=1000 --maxBatches=200
 *
 * npm scripts（支持追加参数）：
 * - npm run wallet:repair-snapshots:dry -- --userId=123
 * - npm run wallet:repair-snapshots:apply -- --userId=123
 */

const EARNING_BIZ_TYPES = [
  'SETTLEMENT_EARNING',
  'SETTLEMENT_EARNING_BASE',
  'SETTLEMENT_EARNING_CARRY',
  'SETTLEMENT_EARNING_CS',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const userIdArg = args.find((a) => a.startsWith('--userId='));
  const batchSizeArg = args.find((a) => a.startsWith('--batchSize='));
  const maxBatchesArg = args.find((a) => a.startsWith('--maxBatches='));
  const backupDirArg = args.find((a) => a.startsWith('--backupDir='));

  const userId = userIdArg ? Number(userIdArg.split('=')[1]) : undefined;
  const batchSize = batchSizeArg ? Number(batchSizeArg.split('=')[1]) : 1000;
  const maxBatches = maxBatchesArg ? Number(maxBatchesArg.split('=')[1]) : 500;
  const backupDir = backupDirArg ? String(backupDirArg.split('=')[1]) : 'scripts/output';
  const dryRun = !apply;

  return {
    dryRun,
    userId: Number.isFinite(userId as number) && (userId as number) > 0 ? Number(userId) : undefined,
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 1000,
    maxBatches: Number.isFinite(maxBatches) && maxBatches > 0 ? maxBatches : 500,
    backupDir,
  };
}

async function main() {
  const prisma = new PrismaClient();
  const { dryRun, userId, batchSize, maxBatches, backupDir } = parseArgs();
  const runTag = new Date().toISOString().replace(/[:.]/g, '-');
  const mode = userId ? `single(userId=${userId})` : 'batch(all-users)';
  const backupFile = path.resolve(process.cwd(), `${backupDir}/wallet-snapshot-backup-${runTag}.jsonl`);

  try {
    console.log(`[repair-wallet-snapshots] start mode=${mode} dryRun=${dryRun} batchSize=${batchSize} maxBatches=${maxBatches}`);

    if (!dryRun) {
      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
      console.log(`[repair-wallet-snapshots] backup file: ${backupFile}`);
    }

    let totalFound = 0;
    let totalUpdated = 0;
    let cursor = 0;

    for (let i = 0; i < maxBatches; i++) {
      const sql = `
        SELECT
          e.id   AS earningTxId,
          e.userId AS userId,
          r.id   AS releaseTxId,
          e.availableAfter AS oldAvailableAfter,
          e.frozenAfter AS oldFrozenAfter
        FROM wallet_transactions e
        INNER JOIN wallet_transactions r
          ON r.sourceType = 'WALLET_HOLD_RELEASE'
         AND r.sourceId = e.id
        WHERE e.id > ?
          AND e.sourceType = 'ORDER_SETTLEMENT'
          AND e.bizType IN ('SETTLEMENT_EARNING', 'SETTLEMENT_EARNING_BASE', 'SETTLEMENT_EARNING_CARRY', 'SETTLEMENT_EARNING_CS')
          AND e.status IN ('AVAILABLE', 'REVERSED')
          AND e.availableAfter IS NOT NULL
          AND e.frozenAfter IS NOT NULL
          AND r.availableAfter IS NOT NULL
          AND r.frozenAfter IS NOT NULL
          AND e.availableAfter = r.availableAfter
          AND e.frozenAfter = r.frozenAfter
          ${userId ? 'AND e.userId = ?' : ''}
        ORDER BY e.id ASC
        LIMIT ?
      `;

      const params: any[] = [cursor];
      if (userId) params.push(userId);
      params.push(batchSize);

      const rows = await prisma.$queryRawUnsafe<Array<{
        earningTxId: number;
        userId: number;
        releaseTxId: number;
        oldAvailableAfter: any;
        oldFrozenAfter: any;
      }>>(sql, ...params);

      if (!rows.length) break;

      totalFound += rows.length;
      cursor = Number(rows[rows.length - 1].earningTxId);

      const txIds = rows.map((r) => Number(r.earningTxId)).filter((n) => Number.isFinite(n) && n > 0);

      if (dryRun) {
        if (i === 0) {
          console.table(rows.slice(0, 20).map((r) => ({
            earningTxId: r.earningTxId,
            userId: r.userId,
            releaseTxId: r.releaseTxId,
            oldAvailableAfter: Number(r.oldAvailableAfter ?? 0),
            oldFrozenAfter: Number(r.oldFrozenAfter ?? 0),
          })));
        }
      } else {
        const backupLines = rows.map((r) =>
          JSON.stringify({
            runTag,
            repairedAt: new Date().toISOString(),
            earningTxId: Number(r.earningTxId),
            userId: Number(r.userId),
            releaseTxId: Number(r.releaseTxId),
            oldAvailableAfter: Number(r.oldAvailableAfter ?? 0),
            oldFrozenAfter: Number(r.oldFrozenAfter ?? 0),
            newAvailableAfter: null,
            newFrozenAfter: null,
          }),
        );
        fs.appendFileSync(backupFile, `${backupLines.join('\n')}\n`, 'utf8');

        const result = await prisma.walletTransaction.updateMany({
          where: {
            id: { in: txIds },
            sourceType: 'ORDER_SETTLEMENT',
            bizType: { in: EARNING_BIZ_TYPES as any },
          },
          data: {
            availableAfter: null,
            frozenAfter: null,
          },
        });
        totalUpdated += Number(result.count || 0);
      }

      if (userId && rows.length < batchSize) break;
    }

    console.log(`[repair-wallet-snapshots] done mode=${mode} found=${totalFound} ${dryRun ? 'wouldUpdate' : 'updated'}=${dryRun ? totalFound : totalUpdated}`);
    if (!dryRun) {
      console.log(`[repair-wallet-snapshots] backup saved: ${backupFile}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('[repair-wallet-snapshots] failed:', e);
  process.exit(1);
});
