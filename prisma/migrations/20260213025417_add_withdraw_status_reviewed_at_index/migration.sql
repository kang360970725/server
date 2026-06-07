-- CreateIndex
CREATE INDEX `wallet_withdrawal_requests_status_reviewedAt_idx` ON `wallet_withdrawal_requests`(`status`, `reviewedAt`);
