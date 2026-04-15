import { Module } from '@nestjs/common';
import { PenaltiesController } from './penalties.controller';
import { PenaltiesService } from './penalties.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletModule } from '../wallet/wallet.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [WalletModule, NotificationsModule],
  controllers: [PenaltiesController],
  providers: [PenaltiesService, PrismaService],
  exports: [PenaltiesService],
})
export class PenaltiesModule {}
