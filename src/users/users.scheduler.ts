import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UsersService } from './users.service';

@Injectable()
export class UsersScheduler {
  private readonly logger = new Logger(UsersScheduler.name);

  constructor(private readonly usersService: UsersService) {}

  @Cron('0 0 6 * * *', { timeZone: 'Asia/Shanghai' })
  async autoFreezeDormantStaffDaily() {
    this.logger.debug('[staff-auto-freeze] disabled; activity assessment replaces dormant freezing');
    return;
    /* istanbul ignore next */
    try {
      const frozenIds = await this.usersService.autoFreezeDormantStaffUsers();
      if (frozenIds.size > 0) {
        this.logger.log(`[staff-auto-freeze] daily frozen ${frozenIds.size} staff account(s)`);
      }
    } catch (error: any) {
      this.logger.error(`autoFreezeDormantStaffDaily failed: ${error?.message || error}`, error?.stack);
    }
  }
}
