import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CouponsModule } from '../coupons/coupons.module';
import { OrdersModule } from '../orders/orders.module';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { MiniAuthController } from './mini-auth.controller';
import { MiniAnnouncementsController } from './mini-announcements.controller';
import { MiniCouponsController } from './mini-coupons.controller';
import { MiniOrdersController } from './mini-orders.controller';
import { MiniProjectsController } from './mini-projects.controller';
import { MiniWalletController } from './mini-wallet.controller';
import { WalletModule } from '../wallet/wallet.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { MiniHomeController } from './mini-home.controller';
import { WechatPayService } from './wechat-pay.service';
import { MemberModule } from '../member/member.module';
import { MiniMemberController } from './mini-member.controller';

@Module({
  imports: [AuthModule, OrdersModule, WalletModule, CouponsModule, SystemConfigModule, NotificationsModule, MemberModule],
  controllers: [MiniAuthController, MiniOrdersController, MiniWalletController, MiniCouponsController, MiniProjectsController, MiniHomeController, MiniAnnouncementsController, MiniMemberController],
  providers: [PrismaService, WechatPayService],
})
export class MiniModule {}
