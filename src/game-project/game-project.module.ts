import { Module } from '@nestjs/common';
import { GameProjectService } from './game-project.service';
import { GameProjectController } from './game-project.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemConfigModule } from '../system-config/system-config.module';

@Module({
  imports: [PrismaModule, SystemConfigModule],
  controllers: [GameProjectController],
  providers: [GameProjectService],
})
export class GameProjectModule {}
