import { Module } from '@nestjs/common';
import { UserLogsController } from './user-logs.controller';
import { UserLogsService } from './user-logs.service';
import { PrismaService } from '../prisma.service';

@Module({
    controllers: [UserLogsController],
    providers: [UserLogsService, PrismaService],
    exports: [UserLogsService], // ✅ 我把 service export 出去，订单/结算/钱包/提现模块都能直接注入调用 writeLog()
})
export class UserLogsModule {}
