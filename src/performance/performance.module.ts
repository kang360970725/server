import { Module } from '@nestjs/common';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
    controllers: [PerformanceController],
    providers: [PerformanceService, PrismaService],
    exports: [PerformanceService],
})
export class PerformanceModule {}