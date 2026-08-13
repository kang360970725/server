import { Module } from '@nestjs/common';
import { ExcellentStaffController } from './excellent-staff.controller';
import { ExcellentStaffService } from './excellent-staff.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [ExcellentStaffController],
  providers: [ExcellentStaffService, PrismaService],
  exports: [ExcellentStaffService],
})
export class ExcellentStaffModule {}
