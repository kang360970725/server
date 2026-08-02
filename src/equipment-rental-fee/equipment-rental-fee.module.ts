import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { EquipmentRentalFeeController } from './equipment-rental-fee.controller';
import { EquipmentRentalFeeService } from './equipment-rental-fee.service';

@Module({
  controllers: [EquipmentRentalFeeController],
  providers: [EquipmentRentalFeeService, PrismaService],
  exports: [EquipmentRentalFeeService],
})
export class EquipmentRentalFeeModule {}
