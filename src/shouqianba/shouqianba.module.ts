import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletModule } from '../wallet/wallet.module';
import { ShouqianbaController } from './shouqianba.controller';
import { ShouqianbaService } from './shouqianba.service';

@Module({
  imports: [WalletModule],
  controllers: [ShouqianbaController],
  providers: [ShouqianbaService, PrismaService],
  exports: [ShouqianbaService],
})
export class ShouqianbaModule {}
