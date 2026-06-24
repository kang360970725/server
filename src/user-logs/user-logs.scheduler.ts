import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UserLogsService } from './user-logs.service';

@Injectable()
export class UserLogsScheduler {
    private readonly logger = new Logger(UserLogsScheduler.name);
    private readonly retentionDays = 45;
    private readonly batchSize = 5000;
    private readonly maxBatches = 20;

    constructor(private readonly userLogsService: UserLogsService) {}

    /**
     * 每天凌晨 03:20 清理 45 天前的操作日志。
     * 用小批量循环删除，避免单次大事务对线上造成明显抖动。
     */
    @Cron('0 20 3 * * *', { timeZone: 'Asia/Shanghai' })
    async pruneExpiredUserLogsDaily() {
        try {
            const result = await this.userLogsService.pruneExpiredLogs({
                retentionDays: this.retentionDays,
                batchSize: this.batchSize,
                maxBatches: this.maxBatches,
            });

            if (result.totalDeleted > 0 || result.hasMore) {
                this.logger.log(
                    `[user-logs-prune] deleted=${result.totalDeleted}, batches=${result.batches}, cutoff=${result.cutoff}, hasMore=${result.hasMore}`,
                );
            }
        } catch (error: any) {
            this.logger.error(
                `pruneExpiredUserLogsDaily failed: ${error?.message || error}`,
                error?.stack,
            );
        }
    }
}
