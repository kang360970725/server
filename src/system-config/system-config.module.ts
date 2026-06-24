import { Module } from '@nestjs/common';
import { SystemConfigController } from './system-config.controller';
import { SystemConfigService } from './system-config.service';
import { PrismaService } from '../prisma.service';
import { StaffRuleEngineService } from './staff-rule-engine.service';

@Module({
  controllers: [SystemConfigController],
  providers: [SystemConfigService, StaffRuleEngineService, PrismaService],
  exports: [SystemConfigService, StaffRuleEngineService],
})
export class SystemConfigModule {}
