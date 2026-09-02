import { Module } from '@nestjs/common';
import { StaffActivityController } from './staff-activity.controller';
import { StaffActivityService } from './staff-activity.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [StaffActivityController],
  providers: [StaffActivityService, PrismaService],
  exports: [StaffActivityService],
})
export class StaffActivityModule {}
