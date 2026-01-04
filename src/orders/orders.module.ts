import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletModule } from '../wallet/wallet.module';

/**
 * OrdersModule
 * - v0.2 接入 WalletModule：结单结算后写钱包冻结流水
 * - 仅新增 imports，不影响既有 controller/provider 行为
 */
@Module({
    imports: [WalletModule],
    controllers: [OrdersController],
    providers: [OrdersService, PrismaService],
    exports: [OrdersService],
})
export class OrdersModule {}
