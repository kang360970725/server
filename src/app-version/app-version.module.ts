import { Module } from '@nestjs/common';
import { AppVersionController } from './app-version.controller';
import { AppVersionService } from './app-version.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [AppVersionController],
  providers: [AppVersionService, PrismaService],
  exports: [AppVersionService],
})
export class AppVersionModule {}
