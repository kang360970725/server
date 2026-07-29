import { Module } from '@nestjs/common';
import { QuestionnaireController } from './questionnaire.controller';
import { QuestionnaireService } from './questionnaire.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  controllers: [QuestionnaireController],
  providers: [QuestionnaireService, PrismaService],
  exports: [QuestionnaireService],
})
export class QuestionnaireModule {}
