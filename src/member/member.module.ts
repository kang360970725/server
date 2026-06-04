import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WechatPayService } from '../mini/wechat-pay.service';
import { SystemConfigModule } from '../system-config/system-config.module';
import { WalletModule } from '../wallet/wallet.module';
import { MemberController } from './member.controller';
import { MemberService } from './member.service';

@Module({
  imports: [WalletModule, SystemConfigModule],
  controllers: [MemberController],
  providers: [MemberService, PrismaService, WechatPayService],
  exports: [MemberService],
})
export class MemberModule {}
