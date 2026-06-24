import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { UsersService } from './users.service';

@Injectable()
export class UsersScheduler {
  private readonly logger = new Logger(UsersScheduler.name);

  constructor(private readonly usersService: UsersService) {}

  @Cron('0 10 * * * *', { timeZone: 'Asia/Shanghai' })
  async autoFreezeDormantStaffHourly() {
    try {
      const frozenIds = await this.usersService.autoFreezeDormantStaffUsers();
      if (frozenIds.size > 0) {
        this.logger.log(`[staff-auto-freeze] hourly frozen ${frozenIds.size} staff account(s)`);
      }
    } catch (error: any) {
      this.logger.error(`autoFreezeDormantStaffHourly failed: ${error?.message || error}`, error?.stack);
    }
  }
}
