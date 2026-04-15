import { Module } from '@nestjs/common';
import { PenaltiesController } from './penalties.controller';
import { PenaltiesService } from './penalties.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletModule } from '../wallet/wallet.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UserLogsModule } from '../user-logs/user-logs.module';

@Module({
  imports: [WalletModule, NotificationsModule, UserLogsModule],
  controllers: [PenaltiesController],
  providers: [PenaltiesService, PrismaService],
  exports: [PenaltiesService],
})
export class PenaltiesModule {}
