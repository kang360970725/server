import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WechatPayService } from '../mini/wechat-pay.service';
import { SystemConfigModule } from '../system-config/system-config.module';
import { WalletModule } from '../wallet/wallet.module';
import { MemberController } from './member.controller';
import { MemberService } from './member.service';
import { MemberBenefitsController } from './member-benefits.controller';
import { MemberBenefitsService } from './member-benefits.service';

@Module({
  imports: [WalletModule, SystemConfigModule],
  controllers: [MemberController, MemberBenefitsController],
  providers: [MemberService, MemberBenefitsService, PrismaService, WechatPayService],
  exports: [MemberService, MemberBenefitsService],
})
export class MemberModule {}
