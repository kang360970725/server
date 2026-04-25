/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();

  const sqlList: string[] = [
    `
    CREATE TABLE IF NOT EXISTS penalty_rules (
      id INT NOT NULL AUTO_INCREMENT,
      code VARCHAR(32) NOT NULL,
      name VARCHAR(120) NOT NULL,
      category ENUM('SERVICE','ATTENDANCE','DISCIPLINE','SAFETY','OTHER') NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      description VARCHAR(255) NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      sortOrder INT NOT NULL DEFAULT 0,
      createdBy INT NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY penalty_rules_code_key (code),
      KEY idx_penalty_rule_enabled_sort (enabled, sortOrder),
      KEY idx_penalty_rule_category (category, enabled),
      KEY penalty_rules_createdBy_fkey (createdBy),
      CONSTRAINT penalty_rules_createdBy_fkey
        FOREIGN KEY (createdBy) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    `
    CREATE TABLE IF NOT EXISTS penalty_tickets (
      id INT NOT NULL AUTO_INCREMENT,
      ticketNo VARCHAR(32) NOT NULL,
      userId INT NOT NULL,
      creatorId INT NULL,
      appealReviewerId INT NULL,
      status ENUM('PENDING_CONFIRM','APPEAL_PENDING','EFFECTIVE','INVALID') NOT NULL DEFAULT 'PENDING_CONFIRM',
      appealStatus ENUM('NONE','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'NONE',
      ruleAmount DECIMAL(10,2) NOT NULL,
      finalAmount DECIMAL(10,2) NOT NULL,
      deductedAmount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      deductedAt DATETIME(3) NULL,
      deductWalletTxId INT NULL,
      reason VARCHAR(255) NULL,
      sameCategoryStats JSON NULL,
      confirmAt DATETIME(3) NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY penalty_tickets_ticketNo_key (ticketNo),
      KEY idx_penalty_ticket_user_status (userId, status, createdAt),
      KEY idx_penalty_ticket_status (status, createdAt),
      KEY idx_penalty_ticket_appeal (appealStatus, createdAt),
      KEY idx_penalty_ticket_creator (creatorId),
      KEY penalty_tickets_appealReviewerId_fkey (appealReviewerId),
      CONSTRAINT penalty_tickets_userId_fkey
        FOREIGN KEY (userId) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT penalty_tickets_creatorId_fkey
        FOREIGN KEY (creatorId) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT penalty_tickets_appealReviewerId_fkey
        FOREIGN KEY (appealReviewerId) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    `
    CREATE TABLE IF NOT EXISTS penalty_ticket_details (
      id INT NOT NULL AUTO_INCREMENT,
      ticketId INT NOT NULL,
      ruleId INT NULL,
      ruleCodeSnapshot VARCHAR(32) NULL,
      ruleNameSnapshot VARCHAR(120) NOT NULL,
      ruleCategorySnapshot ENUM('SERVICE','ATTENDANCE','DISCIPLINE','SAFETY','OTHER') NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      descriptionSnapshot VARCHAR(255) NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_penalty_ticket_detail_ticket (ticketId),
      KEY idx_penalty_ticket_detail_category (ruleCategorySnapshot),
      KEY penalty_ticket_details_ruleId_fkey (ruleId),
      CONSTRAINT penalty_ticket_details_ticketId_fkey
        FOREIGN KEY (ticketId) REFERENCES penalty_tickets(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT penalty_ticket_details_ruleId_fkey
        FOREIGN KEY (ruleId) REFERENCES penalty_rules(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    `
    CREATE TABLE IF NOT EXISTS penalty_appeals (
      id INT NOT NULL AUTO_INCREMENT,
      ticketId INT NOT NULL,
      userId INT NOT NULL,
      content TEXT NOT NULL,
      status ENUM('NONE','PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
      reviewedBy INT NULL,
      reviewedAt DATETIME(3) NULL,
      reviewRemark VARCHAR(255) NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY penalty_appeals_ticketId_key (ticketId),
      KEY idx_penalty_appeal_user (userId, createdAt),
      KEY idx_penalty_appeal_status (status, createdAt),
      KEY penalty_appeals_reviewedBy_fkey (reviewedBy),
      CONSTRAINT penalty_appeals_ticketId_fkey
        FOREIGN KEY (ticketId) REFERENCES penalty_tickets(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT penalty_appeals_userId_fkey
        FOREIGN KEY (userId) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT penalty_appeals_reviewedBy_fkey
        FOREIGN KEY (reviewedBy) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    `
    CREATE TABLE IF NOT EXISTS penalty_fund_pools (
      id INT NOT NULL,
      totalIn DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      totalOut DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    `
    CREATE TABLE IF NOT EXISTS penalty_fund_flows (
      id INT NOT NULL AUTO_INCREMENT,
      poolId INT NOT NULL DEFAULT 1,
      ticketId INT NULL,
      userId INT NULL,
      direction ENUM('IN','OUT') NOT NULL,
      bizType ENUM('PENALTY_DEDUCT','APPEAL_REFUND','MANUAL_ADJUST') NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      beforeBalance DECIMAL(12,2) NOT NULL,
      afterBalance DECIMAL(12,2) NOT NULL,
      walletTxId INT NULL,
      operatorId INT NULL,
      remark VARCHAR(255) NULL,
      createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uniq_penalty_flow_ticket_biz (ticketId, bizType),
      KEY idx_penalty_fund_flow_created (createdAt),
      KEY idx_penalty_fund_flow_user (userId, createdAt),
      KEY idx_penalty_fund_flow_biz (bizType, createdAt),
      KEY penalty_fund_flows_poolId_fkey (poolId),
      KEY penalty_fund_flows_ticketId_fkey (ticketId),
      KEY penalty_fund_flows_userId_fkey (userId),
      CONSTRAINT penalty_fund_flows_poolId_fkey
        FOREIGN KEY (poolId) REFERENCES penalty_fund_pools(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT penalty_fund_flows_ticketId_fkey
        FOREIGN KEY (ticketId) REFERENCES penalty_tickets(id)
        ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT penalty_fund_flows_userId_fkey
        FOREIGN KEY (userId) REFERENCES users(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `,
    `
    INSERT IGNORE INTO penalty_fund_pools (id, totalIn, totalOut, balance)
    VALUES (1, 0.00, 0.00, 0.00);
    `,
  ];

  try {
    for (const sql of sqlList) {
      await prisma.$executeRawUnsafe(sql);
    }
    console.log('[ensure-penalty-tables] done');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('[ensure-penalty-tables] failed:', e);
  process.exit(1);
});

