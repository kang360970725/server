import { Controller,Req, Get, Query,Post, Request, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WalletService } from './wallet.service';
import { QueryWalletTransactionsDto } from './dto/query-wallet-transactions.dto';
import { QueryWalletHoldsDto } from './dto/query-wallet-holds.dto';
import { FileInterceptor } from '@nestjs/platform-express';

/**
 * Wallet Controller（V0.2）
 * - 仅当前登录用户的钱包信息（管理端/陪玩端通用）
 * - 不做权限细分（先跑通）；后续如要限制可加 PermissionsGuard
 */
@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
    constructor(private readonly walletService: WalletService) {}

    /**
     * 获取当前用户钱包账户
     * GET /wallet/account
     */
    @Get('account')
    async getMyAccount(@Request() req: any) {
        const userId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
        return this.walletService.getOrCreateMyAccount(userId);
    }

    /**
     * 查询当前用户流水
     * GET /wallet/transactions?page&limit&status&bizType&direction&orderId&dispatchId&startAt&endAt
     */
    @Get('transactions')
    async listMyTransactions(@Query() query: QueryWalletTransactionsDto, @Request() req: any) {
        const userId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
        return this.walletService.listMyTransactions(userId, query);
    }

    /**
     * 查询当前用户冻结单
     * GET /wallet/holds?page&limit&status
     */
    @Get('holds')
    async listMyHolds(@Query() query: QueryWalletHoldsDto, @Request() req: any) {
        const userId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
        return this.walletService.listMyHolds(userId, query);
    }


    @Post('withdraw/qr-code')
    @UseInterceptors(FileInterceptor('file'))
    async uploadWithdrawQrCode(@UploadedFile() file: any, @Req() req: any) {
        const userId = req.user.userId;
        return this.walletService.uploadWithdrawQrCodeOnce({ userId, file });
    }

    @Get('withdraw/qr-code-url')
    async getWithdrawQrCodeUrl(@Req() req: any) {
        const userId = req.user.userId;
        return this.walletService.getWithdrawQrCodeUrl({ userId });
    }

}
