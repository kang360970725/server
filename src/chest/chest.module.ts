import { Module } from '@nestjs/common';
import { ChestController } from './chest.controller';
import { ChestService } from './chest.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [ChestController],
  providers: [ChestService, PrismaService],
  exports: [ChestService],
})
export class ChestModule {}

