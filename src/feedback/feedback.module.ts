import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { MiniFeedbackController } from './mini-feedback.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({ imports: [NotificationsModule], controllers: [FeedbackController, MiniFeedbackController], providers: [FeedbackService, PrismaService] })
export class FeedbackModule {}
