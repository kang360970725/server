import { Controller, Body, Req, Get, Query, Post, Request, UseGuards, UseInterceptors, UploadedFile, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WalletService } from './wallet.service';
import { QueryWalletTransactionsDto } from './dto/query-wallet-transactions.dto';
import { QueryWalletHoldsDto } from './dto/query-wallet-holds.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import {WalletDepositService} from "./wallet.deposit.service";
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';

const WITHDRAWALS_PAGE = 'wallet:withdrawals:page';
const WALLET_TRANSACTIONS_PAGE = 'wallet:transactions:page';
const FINANCE_RECORDS_PAGE = 'finance:records:list';

function hasAnyPermission(user: any, permissions: string[]) {
    const userType = String(user?.userType || '').trim().toUpperCase();
    const roleName = String(user?.roleName || '').trim().toUpperCase();
    if (userType === 'SUPER_ADMIN' || roleName === 'SUPER_ADMIN') return true;
    const userPermissions = Array.isArray(user?.permissions) ? user.permissions : [];
    return permissions.some((p) => userPermissions.includes(p));
}

/**
 * Wallet Controller（V0.2）
 * - 仅当前登录用户的钱包信息（管理端/陪玩端通用）
 * - 不做权限细分（先跑通）；后续如要限制可加 PermissionsGuard
 */
@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
    constructor(private readonly walletService: WalletService,
                private readonly walletDepositService: WalletDepositService,) {}

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

        const loginUserId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);

        // 如果传了 userId 就查指定用户
        const userId = query.userId ? Number(query.userId) : loginUserId;
        if (userId !== loginUserId && !hasAnyPermission(req?.user, [WALLET_TRANSACTIONS_PAGE, WITHDRAWALS_PAGE, FINANCE_RECORDS_PAGE])) {
            throw new ForbiddenException('无权查询其他用户钱包流水');
        }

        return this.walletService.listMyTransactions(userId, query);
    }

    /**
     * 单用户钱包重放预核算（只读）
     * GET /wallet/replay-preview?userId=123&startAt=2026-01-01&endAt=2026-04-20
     */
    @UseGuards(PermissionsGuard)
    @Permissions(WITHDRAWALS_PAGE)
    @Get('replay-preview')
    async replayPreview(@Query() query: any, @Request() req: any) {
        const loginUserId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
        const userId = Number(query?.userId || loginUserId);
        return this.walletService.previewReplayByUser({
            userId,
            startAt: query?.startAt,
            endAt: query?.endAt,
            limitMismatches: query?.limitMismatches ? Number(query.limitMismatches) : undefined,
            mode: String(query?.mode || 'full').trim().toLowerCase() === 'legacy' ? 'legacy' : 'full',
        });
    }

    @UseGuards(PermissionsGuard)
    @Permissions(WITHDRAWALS_PAGE)
    @Get('anomalies')
    async auditAnomalies(@Query() query: any) {
        return this.walletService.auditWalletAnomalies({
            userId: query?.userId ? Number(query.userId) : undefined,
            onlyIssues: String(query?.onlyIssues ?? 'true').trim().toLowerCase() !== 'false',
            limit: query?.limit ? Number(query.limit) : undefined,
        });
    }

    @UseGuards(PermissionsGuard)
    @Permissions(WITHDRAWALS_PAGE)
    @Post('anomalies/repair')
    async repairAnomalies(@Body() body: any, @Req() req: any) {
        const operatorId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub ?? 0) || undefined;
        return this.walletService.repairWalletAnomalies({
            userId: body?.userId ? Number(body.userId) : undefined,
            apply: body?.apply === true,
            includeDeficitUsers: body?.includeDeficitUsers === true,
            limit: body?.limit ? Number(body.limit) : undefined,
            reason: body?.reason ? String(body.reason).trim() : undefined,
            operatorId,
        });
    }

    @UseGuards(PermissionsGuard)
    @Permissions(WITHDRAWALS_PAGE)
    @Post('anomalies/repair-rollback')
    async rollbackRepairAdjustments(@Body() body: any, @Req() req: any) {
        const operatorId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub ?? 0) || undefined;
        return this.walletService.rollbackWalletRepairAdjustments({
            userId: body?.userId ? Number(body.userId) : undefined,
            apply: body?.apply === true,
            limit: body?.limit ? Number(body.limit) : undefined,
            onlyBalanceIncrease: body?.onlyBalanceIncrease !== false,
            reason: body?.reason ? String(body.reason).trim() : undefined,
            operatorId,
        });
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

    @Post('deposit/manual')
    @UseGuards(PermissionsGuard)
    @Permissions(WITHDRAWALS_PAGE, FINANCE_RECORDS_PAGE)
    async manualDeposit(@Body() body: any, @Req() req: any) {

        const operatorId = req.user?.userId;

        const { userId, amount, remark } = body;

        return this.walletDepositService.manualDeposit({
            userId: Number(userId),
            amount: Number(amount),
            remark,
            operatorId,
        });
    }


    @Get('deposit-transactions')
    @UseGuards(PermissionsGuard)
    @Permissions(WITHDRAWALS_PAGE, FINANCE_RECORDS_PAGE)
    async depositTransactions(@Query() query: any) {

        const page = Math.max(1, Number(query.page ?? 1));
        const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));

        return this.walletDepositService.listDepositTransactions({
            userId: Number(query.userId),
            page,
            limit,
        });
    }

}
