import { Module } from '@nestjs/common';
import { SystemConfigController } from './system-config.controller';
import { SystemConfigService } from './system-config.service';
import { PrismaService } from '../prisma.service';

@Module({
  controllers: [SystemConfigController],
  providers: [SystemConfigService, PrismaService],
  exports: [SystemConfigService],
})
export class SystemConfigModule {}
