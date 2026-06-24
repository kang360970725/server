import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeNotificationsService } from './realtime-notifications.service';
import { SystemConfigModule } from '../system-config/system-config.module';
import { MiniSubscribeMessageService } from './mini-subscribe-message.service';

@Module({
  imports: [SystemConfigModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, PrismaService, RealtimeNotificationsService, MiniSubscribeMessageService],
  exports: [NotificationsService, MiniSubscribeMessageService],
})
export class NotificationsModule {}
