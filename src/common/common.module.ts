import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CommonUploadController } from './common-upload.controller';

@Module({
    imports: [PrismaModule],
    controllers: [CommonUploadController],
})
export class CommonModule {}
