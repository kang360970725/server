import { Module } from '@nestjs/common';
import { GameProjectService } from './game-project.service';
import { GameProjectController } from './game-project.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [GameProjectController],
  providers: [GameProjectService],
})
export class GameProjectModule {}
