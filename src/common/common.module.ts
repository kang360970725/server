import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { CommonUploadController } from './common-upload.controller';

@Module({
    imports: [PrismaModule, SystemConfigModule],
    controllers: [CommonUploadController],
})
export class CommonModule {}
