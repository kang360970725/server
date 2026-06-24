const { PrismaClient } = require('@prisma/client');
const { execFileSync } = require('node:child_process');

const prisma = new PrismaClient();

const STAFF_EXIT_MIGRATION = '20260619152000_add_staff_exit_status';

async function tableExists(tableName) {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT COUNT(1) AS c
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
    `,
    tableName,
  );
  return Number(rows?.[0]?.c || 0) > 0;
}

async function columnExists(tableName, columnName) {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT COUNT(1) AS c
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
    `,
    tableName,
    columnName,
  );
  return Number(rows?.[0]?.c || 0) > 0;
}

async function indexExists(tableName, indexName) {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT COUNT(1) AS c
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
    `,
    tableName,
    indexName,
  );
  return Number(rows?.[0]?.c || 0) > 0;
}

async function ensureStaffExitMigrationState() {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT migration_name, finished_at, rolled_back_at
      FROM _prisma_migrations
      WHERE migration_name = ?
      ORDER BY started_at DESC
      LIMIT 1
    `,
    STAFF_EXIT_MIGRATION,
  );

  const row = rows?.[0];
  if (!row) {
    console.log(`[migration-repair] no record found for ${STAFF_EXIT_MIGRATION}, skip`);
    return false;
  }

  if (row.finished_at || row.rolled_back_at) {
    console.log(`[migration-repair] ${STAFF_EXIT_MIGRATION} already resolved, skip`);
    return false;
  }

  console.log(`[migration-repair] repairing failed migration ${STAFF_EXIT_MIGRATION}`);

  if (!(await columnExists('users', 'staffEmploymentStatus'))) {
    await prisma.$executeRawUnsafe(
      "ALTER TABLE `users` ADD COLUMN `staffEmploymentStatus` ENUM('ACTIVE', 'EXITED', 'BLACKLISTED') NOT NULL DEFAULT 'ACTIVE'",
    );
  }
  if (!(await columnExists('users', 'staffCooldownUntil'))) {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE `users` ADD COLUMN `staffCooldownUntil` DATETIME(3) NULL',
    );
  }
  if (!(await columnExists('users', 'staffExitedAt'))) {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE `users` ADD COLUMN `staffExitedAt` DATETIME(3) NULL',
    );
  }
  if (!(await indexExists('users', 'users_userType_staffEmploymentStatus_idx'))) {
    await prisma.$executeRawUnsafe(
      'CREATE INDEX `users_userType_staffEmploymentStatus_idx` ON `users`(`userType`, `staffEmploymentStatus`)',
    );
  }

  await prisma.$executeRawUnsafe(
    `
      ALTER TABLE \`wallet_transactions\`
      MODIFY COLUMN \`bizType\` ENUM(
        'SETTLEMENT_EARNING',
        'SETTLEMENT_EARNING_BASE',
        'SETTLEMENT_EARNING_CARRY',
        'SETTLEMENT_BOMB_LOSS',
        'SETTLEMENT_EARNING_CS',
        'RELEASE_FROZEN',
        'REFUND_REVERSAL',
        'WITHDRAW_RESERVE',
        'WITHDRAW_RELEASE',
        'WITHDRAW_PAYOUT',
        'DEPOSIT_REFUND',
        'DEPOSIT_ADD',
        'DEPOSIT_DEDUCT',
        'OFFLINE_FEE_PAYMENT',
        'SETTLEMENT_REVERSAL',
        'SETTLEMENT_RECALC',
        'MEMBER_RECHARGE',
        'MEMBER_RECHARGE_BONUS',
        'MEMBER_ORDER_CONSUME',
        'MEMBER_RECHARGE_REFUND',
        'STAFF_EXIT_RELEASE',
        'STAFF_EXIT_CLEAR'
      ) NOT NULL DEFAULT 'SETTLEMENT_EARNING'
    `,
  );

  if (!(await tableExists('wallet_deposit_transactions'))) {
    await prisma.$executeRawUnsafe(
      `
        CREATE TABLE \`wallet_deposit_transactions\` (
          \`id\` INT NOT NULL AUTO_INCREMENT,
          \`userId\` INT NOT NULL,
          \`amount\` DECIMAL(10,2) NOT NULL,
          \`bizType\` ENUM(
            'WITHDRAW_PERCENT',
            'REWARD_TRANSFER',
            'MANUAL_DEPOSIT',
            'PENALTY_DEDUCT',
            'DEPOSIT_REFUND',
            'STAFF_EXIT_RELEASE',
            'STAFF_EXIT_CLEAR'
          ) NOT NULL,
          \`remark\` VARCHAR(255) NULL,
          \`operatorId\` INT NULL,
          \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          PRIMARY KEY (\`id\`),
          INDEX \`wallet_deposit_transactions_userId_idx\`(\`userId\`),
          CONSTRAINT \`wallet_deposit_transactions_userId_fkey\`
            FOREIGN KEY (\`userId\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `,
    );
  }

  await prisma.$executeRawUnsafe(
    `
      ALTER TABLE \`wallet_deposit_transactions\`
      MODIFY COLUMN \`bizType\` ENUM(
        'WITHDRAW_PERCENT',
        'REWARD_TRANSFER',
        'MANUAL_DEPOSIT',
        'PENALTY_DEDUCT',
        'DEPOSIT_REFUND',
        'STAFF_EXIT_RELEASE',
        'STAFF_EXIT_CLEAR'
      ) NOT NULL
    `,
  );

  console.log(`[migration-repair] base SQL repaired for ${STAFF_EXIT_MIGRATION}`);
  return true;
}

async function main() {
  let shouldResolve = false;
  try {
    shouldResolve = await ensureStaffExitMigrationState();
  } finally {
    await prisma.$disconnect();
  }

  if (!shouldResolve) return;

  console.log(`[migration-repair] resolving ${STAFF_EXIT_MIGRATION} as applied`);
  execFileSync(
    'npx',
    [
      'prisma',
      'migrate',
      'resolve',
      '--schema=./prisma/schema.prisma',
      '--applied',
      STAFF_EXIT_MIGRATION,
    ],
    { stdio: 'inherit' },
  );
}

main().catch((error) => {
  console.error('[migration-repair] failed:', error?.message || error);
  process.exit(1);
});
