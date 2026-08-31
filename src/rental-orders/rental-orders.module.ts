import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { WalletModule } from '../wallet/wallet.module';
import { AdminRentalOrdersController } from './admin-rental-orders.controller';
import { RentalOrdersService } from './rental-orders.service';

@Module({
  imports: [WalletModule], controllers: [AdminRentalOrdersController],
  providers: [PrismaService, RentalOrdersService], exports: [RentalOrdersService],
})
export class RentalOrdersModule {}
