import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeNotificationsService } from './realtime-notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, PrismaService, RealtimeNotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
