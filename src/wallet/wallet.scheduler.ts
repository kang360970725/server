import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WalletService } from './wallet.service';

/**
 * WalletScheduler（V0.1）
 * - 周期扫描到期的 WalletHold
 * - 执行解冻：frozen -> available
 *
 * 说明：
 * - 先用 Cron（每小时一次），频率后续可调
 * - 任务是幂等的：WalletHold.status + 唯一约束会阻止重复解冻
 */
@Injectable()
export class WalletScheduler {
    private readonly logger = new Logger(WalletScheduler.name);

    constructor(private wallet: WalletService) {
        this.logger.log('[WalletScheduler] constructed'); // ✅ 只要模块被加载，一启动就会打印
    }

    /**
     * 每小时整点执行一次
     */
    @Cron('0 0 * * * *')
    async releaseDueHoldsHourly() {
        try {
            const result = await this.wallet.releaseDueHoldsInBatches({ batchSize: 200 });
            if (result.totalReleased > 0) {
                this.logger.log(`Released wallet holds total: ${result.totalReleased}`);
            }
        } catch (e: any) {
            this.logger.error(`releaseDueHoldsHourly failed: ${e?.message || e}`, e?.stack);
        }
    }

}
