import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
    controllers: [FinanceController],
    providers: [FinanceService, PrismaService],
})
export class FinanceModule {}
