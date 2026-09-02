const { PrismaClient } = require('@prisma/client');
const { execFileSync } = require('node:child_process');

const prisma = new PrismaClient();

const STAFF_EXIT_MIGRATION = '20260619152000_add_staff_exit_status';
const EXCELLENT_STAFF_MIGRATION = '20260813093000_add_excellent_staff_and_renewal_snapshot';
const ORDER_CUSTOMER_IDENTIFIER_MIGRATION = '20260828161000_add_order_customer_identifier_type';
const STAFF_ACTIVITY_MIGRATION = '20260902100000_add_staff_activity_assessment';

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

async function constraintExists(tableName, constraintName) {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT COUNT(1) AS c
      FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ?
    `,
    tableName,
    constraintName,
  );
  return Number(rows?.[0]?.c || 0) > 0;
}

async function getLatestMigrationState(migrationName) {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT migration_name, finished_at, rolled_back_at
      FROM _prisma_migrations
      WHERE migration_name = ?
      ORDER BY started_at DESC
      LIMIT 1
    `,
    migrationName,
  );
  return rows?.[0] || null;
}

async function addForeignKeyIfMissing(tableName, constraintName, sql) {
  if (await constraintExists(tableName, constraintName)) return;
  await prisma.$executeRawUnsafe(sql);
}

async function ensureStaffExitMigrationState() {
  const row = await getLatestMigrationState(STAFF_EXIT_MIGRATION);
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

async function ensureExcellentStaffMigrationState() {
  const row = await getLatestMigrationState(EXCELLENT_STAFF_MIGRATION);

  if (!row) {
    console.log(`[migration-repair] no record found for ${EXCELLENT_STAFF_MIGRATION}, skip`);
    return false;
  }

  if (row.finished_at || row.rolled_back_at) {
    console.log(`[migration-repair] ${EXCELLENT_STAFF_MIGRATION} already resolved, skip`);
    return false;
  }

  console.log(`[migration-repair] repairing failed migration ${EXCELLENT_STAFF_MIGRATION}`);

  if (!(await tableExists('excellent_staff'))) {
    await prisma.$executeRawUnsafe(
      `
        CREATE TABLE \`excellent_staff\` (
          \`id\` INTEGER NOT NULL AUTO_INCREMENT,
          \`userId\` INTEGER NOT NULL,
          \`status\` VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
          \`assignedBy\` INTEGER NULL,
          \`assignedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          \`removedBy\` INTEGER NULL,
          \`removedAt\` DATETIME(3) NULL,
          \`remark\` VARCHAR(255) NULL,
          \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          \`updatedAt\` DATETIME(3) NOT NULL,
          UNIQUE INDEX \`excellent_staff_userId_key\` (\`userId\`),
          INDEX \`idx_excellent_staff_status_time\` (\`status\`, \`assignedAt\`),
          INDEX \`excellent_staff_assignedBy_idx\` (\`assignedBy\`),
          INDEX \`excellent_staff_removedBy_idx\` (\`removedBy\`),
          PRIMARY KEY (\`id\`)
        ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
      `,
    );
  }

  if (!(await indexExists('excellent_staff', 'excellent_staff_userId_key'))) {
    await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX `excellent_staff_userId_key` ON `excellent_staff`(`userId`)');
  }
  if (!(await indexExists('excellent_staff', 'idx_excellent_staff_status_time'))) {
    await prisma.$executeRawUnsafe('CREATE INDEX `idx_excellent_staff_status_time` ON `excellent_staff`(`status`, `assignedAt`)');
  }
  if (!(await indexExists('excellent_staff', 'excellent_staff_assignedBy_idx'))) {
    await prisma.$executeRawUnsafe('CREATE INDEX `excellent_staff_assignedBy_idx` ON `excellent_staff`(`assignedBy`)');
  }
  if (!(await indexExists('excellent_staff', 'excellent_staff_removedBy_idx'))) {
    await prisma.$executeRawUnsafe('CREATE INDEX `excellent_staff_removedBy_idx` ON `excellent_staff`(`removedBy`)');
  }

  await addForeignKeyIfMissing(
    'excellent_staff',
    'excellent_staff_userId_fkey',
    'ALTER TABLE `excellent_staff` ADD CONSTRAINT `excellent_staff_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  );
  await addForeignKeyIfMissing(
    'excellent_staff',
    'excellent_staff_assignedBy_fkey',
    'ALTER TABLE `excellent_staff` ADD CONSTRAINT `excellent_staff_assignedBy_fkey` FOREIGN KEY (`assignedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  );
  await addForeignKeyIfMissing(
    'excellent_staff',
    'excellent_staff_removedBy_fkey',
    'ALTER TABLE `excellent_staff` ADD CONSTRAINT `excellent_staff_removedBy_fkey` FOREIGN KEY (`removedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  );

  if (!(await columnExists('order_renewal_groups', 'bonusEligibleUserIds'))) {
    await prisma.$executeRawUnsafe('ALTER TABLE `order_renewal_groups` ADD COLUMN `bonusEligibleUserIds` JSON NULL');
  }
  if (!(await columnExists('order_renewal_groups', 'bonusEligibleSnapshot'))) {
    await prisma.$executeRawUnsafe('ALTER TABLE `order_renewal_groups` ADD COLUMN `bonusEligibleSnapshot` JSON NULL');
  }

  console.log(`[migration-repair] base SQL repaired for ${EXCELLENT_STAFF_MIGRATION}`);
  return true;
}

async function ensureOrderCustomerIdentifierMigrationState() {
  const row = await getLatestMigrationState(ORDER_CUSTOMER_IDENTIFIER_MIGRATION);
  if (!row) {
    console.log(`[migration-repair] no record found for ${ORDER_CUSTOMER_IDENTIFIER_MIGRATION}, skip`);
    return false;
  }
  if (row.finished_at || row.rolled_back_at) {
    console.log(`[migration-repair] ${ORDER_CUSTOMER_IDENTIFIER_MIGRATION} already resolved, skip`);
    return false;
  }

  console.log(`[migration-repair] repairing failed migration ${ORDER_CUSTOMER_IDENTIFIER_MIGRATION}`);
  // 该历史迁移错误地使用了 `orders`；生产 schema 的真实映射是 `Order`。
  // 同时兼容少数 lower_case_table_names 环境，且表名只从固定白名单选择。
  const orderTable = (await tableExists('Order')) ? 'Order' : ((await tableExists('orders')) ? 'orders' : null);
  if (!orderTable) {
    throw new Error('cannot repair customer identifier migration: neither `Order` nor `orders` exists');
  }

  if (!(await columnExists(orderTable, 'customerIdentifierType'))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`${orderTable}\` ADD COLUMN \`customerIdentifierType\` VARCHAR(20) NULL`,
    );
  }
  if (!(await columnExists(orderTable, 'customerOriginalIdentifier'))) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE \`${orderTable}\` ADD COLUMN \`customerOriginalIdentifier\` TEXT NULL`,
    );
  }
  if (await columnExists(orderTable, 'customerGameId')) {
    await prisma.$executeRawUnsafe(
      `
        UPDATE \`${orderTable}\`
        SET \`customerIdentifierType\` = COALESCE(\`customerIdentifierType\`, 'GAME_ID'),
            \`customerOriginalIdentifier\` = COALESCE(\`customerOriginalIdentifier\`, \`customerGameId\`)
        WHERE \`customerIdentifierType\` IS NULL
           OR \`customerOriginalIdentifier\` IS NULL
      `,
    );
  } else {
    await prisma.$executeRawUnsafe(
      `UPDATE \`${orderTable}\` SET \`customerIdentifierType\` = 'GAME_ID' WHERE \`customerIdentifierType\` IS NULL`,
    );
  }
  if (!(await indexExists(orderTable, 'idx_order_customer_identifier_type'))) {
    await prisma.$executeRawUnsafe(
      `CREATE INDEX \`idx_order_customer_identifier_type\` ON \`${orderTable}\`(\`customerIdentifierType\`)`,
    );
  }

  console.log(`[migration-repair] base SQL repaired for ${ORDER_CUSTOMER_IDENTIFIER_MIGRATION} on table ${orderTable}`);
  return true;
}

async function shouldRollBackFailedStaffActivityMigration() {
  const row = await getLatestMigrationState(STAFF_ACTIVITY_MIGRATION);
  if (!row) {
    console.log(`[migration-repair] no record found for ${STAFF_ACTIVITY_MIGRATION}, skip`);
    return false;
  }
  if (row.finished_at || row.rolled_back_at) {
    console.log(`[migration-repair] ${STAFF_ACTIVITY_MIGRATION} already resolved, skip`);
    return false;
  }

  const hasPartialSchema =
    (await columnExists('users', 'activityAssessmentEnabled')) ||
    (await columnExists('users', 'activityAssessmentStartedAt')) ||
    (await columnExists('users', 'activityLastCompletedAt')) ||
    (await columnExists('users', 'activityNextChargeAt')) ||
    (await columnExists('users', 'activityTimerPaused')) ||
    (await tableExists('staff_leaves')) ||
    (await tableExists('staff_activity_charges'));

  if (hasPartialSchema) {
    throw new Error(`cannot automatically roll back ${STAFF_ACTIVITY_MIGRATION}: partial schema objects already exist`);
  }

  console.log(`[migration-repair] failed ${STAFF_ACTIVITY_MIGRATION} has no partial schema, resolving as rolled back`);
  return true;
}

async function main() {
  const migrationsToResolve = [];
  const migrationsToRollBack = [];
  try {
    if (await ensureStaffExitMigrationState()) migrationsToResolve.push(STAFF_EXIT_MIGRATION);
    if (await ensureExcellentStaffMigrationState()) migrationsToResolve.push(EXCELLENT_STAFF_MIGRATION);
    if (await ensureOrderCustomerIdentifierMigrationState()) migrationsToResolve.push(ORDER_CUSTOMER_IDENTIFIER_MIGRATION);
    if (await shouldRollBackFailedStaffActivityMigration()) migrationsToRollBack.push(STAFF_ACTIVITY_MIGRATION);
  } finally {
    await prisma.$disconnect();
  }

  for (const migrationName of migrationsToRollBack) {
    console.log(`[migration-repair] resolving ${migrationName} as rolled back`);
    execFileSync(
      'npx',
      [
        'prisma',
        'migrate',
        'resolve',
        '--schema=./prisma/schema.prisma',
        '--rolled-back',
        migrationName,
      ],
      { stdio: 'inherit' },
    );
  }

  if (!migrationsToResolve.length) return;

  for (const migrationName of migrationsToResolve) {
    console.log(`[migration-repair] resolving ${migrationName} as applied`);
    execFileSync(
      'npx',
      [
        'prisma',
        'migrate',
        'resolve',
        '--schema=./prisma/schema.prisma',
        '--applied',
        migrationName,
      ],
      { stdio: 'inherit' },
    );
  }
}

main().catch((error) => {
  console.error('[migration-repair] failed:', error?.message || error);
  process.exit(1);
});
