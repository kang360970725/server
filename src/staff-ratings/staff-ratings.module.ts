import { Module } from '@nestjs/common';
import { StaffRatingsService } from './staff-ratings.service';
import { StaffRatingsController } from './staff-ratings.controller';
import { PrismaService } from '../prisma.service';

@Module({
    controllers: [StaffRatingsController],
    providers: [StaffRatingsService, PrismaService],
})
export class StaffRatingsModule {}
