import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { MiniappProtocolsController } from './miniapp-protocols.controller';
import { MiniappProtocolsService } from './miniapp-protocols.service';

@Module({
  imports: [PrismaModule, SystemConfigModule],
  controllers: [MiniappProtocolsController],
  providers: [MiniappProtocolsService],
})
export class MiniappProtocolsModule {}
