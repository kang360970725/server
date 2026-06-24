import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { UsersScheduler } from './users.scheduler';
import { PrismaService } from '../prisma.service';
import { WalletModule } from '../wallet/wallet.module';
import { MemberModule } from '../member/member.module';
import { SystemConfigModule } from '../system-config/system-config.module';

@Module({
  imports: [WalletModule, MemberModule, SystemConfigModule],
  controllers: [UsersController],
  providers: [UsersService, UsersScheduler, PrismaService],
  exports: [UsersService],
})
export class UsersModule {}
