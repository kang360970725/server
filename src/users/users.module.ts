import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UsersScheduler } from './users.scheduler';
import { PrismaService } from '../prisma.service';
import { WalletModule } from '../wallet/wallet.module';
import { MemberModule } from '../member/member.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { OfflineFeeModule } from '../offline-fee/offline-fee.module';
import { EquipmentRentalFeeModule } from '../equipment-rental-fee/equipment-rental-fee.module';

@Module({
  imports: [WalletModule, MemberModule, SystemConfigModule, OfflineFeeModule, EquipmentRentalFeeModule],
  controllers: [UsersController],
  providers: [UsersService, UsersScheduler, PrismaService],
  exports: [UsersService],
})
export class UsersModule {}
