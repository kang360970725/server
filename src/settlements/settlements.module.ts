// src/settlements/settlements.module.ts
import { Module } from '@nestjs/common';
import { SettlementsService } from './settlements.service';
import { SettlementsController } from './settlements.controller';
import { PrismaService } from '../prisma/prisma.service';

@Module({
    controllers: [SettlementsController],
    providers: [SettlementsService, PrismaService],
})
export class SettlementsModule {}
