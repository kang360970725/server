import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { WalletService } from './wallet.service';
import { WalletScheduler } from './wallet.scheduler';
import {WalletController} from "./wallet.controller";

/**
 * WalletModule（V0.1）
 * - 负责钱包账户（WalletAccount）与后续钱包流水/冻结单的统一入口
 * - 当前 Step 2 只提供：确保用户钱包账户存在（ensureWalletAccount）
 *
 * ⚠️ 注意：本项目目前多个模块重复提供 PrismaService（UsersModule 等）。
 * 这里沿用现有习惯，避免大范围重构。
 */
@Module({
    controllers: [WalletController],
    providers: [WalletService, WalletScheduler,PrismaService],
    exports: [WalletService],
})
export class WalletModule {}
