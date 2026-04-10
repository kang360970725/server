import { Module } from '@nestjs/common';
import { OfflineFeeController } from './offline-fee.controller';
import { OfflineFeeService } from './offline-fee.service';
import { PrismaService } from '../prisma.service';
import { SystemConfigModule } from '../system-config/system-config.module';

@Module({
  imports: [SystemConfigModule],
  controllers: [OfflineFeeController],
  providers: [OfflineFeeService, PrismaService],
  exports: [OfflineFeeService],
})
export class OfflineFeeModule {}
