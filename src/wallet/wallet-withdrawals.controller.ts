import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { WalletWithdrawalsService } from './wallet-withdrawals.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

// 按你项目实际路径替换
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';

const WITHDRAWALS_PAGE = 'wallet:withdrawals:page';

@Controller('wallet/withdrawals')
@UseGuards(JwtAuthGuard) // ✅ 统一要求登录
export class WalletWithdrawalsController {
    constructor(private readonly service: WalletWithdrawalsService) {}

    // ✅ 打手：申请提现（仅登录）
    @Post('apply')
    async apply(
        @Req() req: any,
        @Body()
            body: {
            amount: number;
            idempotencyKey: string;
            remark?: string;
            channel?: 'MANUAL' | 'WECHAT';
            payOfflineFeeAmount?: number;
        },
    ) {
        const userId = req.user?.userId; // 以你 jwt 注入结构为准
        return this.service.applyWithdrawal({ ...body, userId });
    }

    /**
     * ✅ 获取提现基础信息（押金余额 + 押金阈值）
     */
    @Get('withdraw-info')
    async getWithdrawInfo(@Req() req: any) {

        const userId = req.user.userId;

        return this.service.getWithdrawInfo(userId);

    }

    // ✅ 打手：我的提现记录（仅登录）
    @Get('mine')
    async mine(@Req() req: any) {
        const userId = req.user?.userId;
        return this.service.listMine(userId);
    }

    // ✅ 管理端：待审核列表（登录 + 权限）
    @UseGuards(PermissionsGuard)
    @Permissions(WITHDRAWALS_PAGE)
    @Get('pending')
    async pending(@Query('reviewDate') reviewDate?: string) {
        return this.service.listPending(reviewDate);
    }

    // ✅ 管理端：全量记录（登录 + 权限）
    @UseGuards(PermissionsGuard)
    @Permissions(WITHDRAWALS_PAGE)
    @Post('list')
    async list(
        @Body()
            body: {
            page: number;
            pageSize: number;
            status?: string;
            channel?: string;
            userId?: number;
            requestNo?: string;
            createdAtFrom?: string;
            createdAtTo?: string;
        },
    ) {
        return this.service.listAll(body);
    }

    // ✅ 管理端：提现对账汇总（按审批时间范围，按人统计）
    @UseGuards(PermissionsGuard)
    @Permissions(WITHDRAWALS_PAGE)
    @Post('reconcile-summary')
    async reconcileSummary(
        @Body()
            body: {
            status?: string;
            channel?: string;
            userId?: number;
            requestNo?: string;
            createdAtFrom?: string;
            createdAtTo?: string;
        },
    ) {
        return this.service.reconcileSummary(body || {});
    }

    // ✅ 管理端：审批提现（登录 + 权限）
    @UseGuards(PermissionsGuard)
    @Permissions(WITHDRAWALS_PAGE)
    @Post('review')
    async review(
        @Req() req: any,
        @Body()
            body: {
            requestId: number;
            approve: boolean;
            reviewRemark?: string;
        },
    ) {
        const reviewerId = req.user?.userId;
        return this.service.reviewWithdrawal({ ...body, reviewerId });
    }

    // ✅ 管理端：废除异常提现申请（历史修复/重新入驻冲抵兜底）
    @UseGuards(PermissionsGuard)
    @Permissions(WITHDRAWALS_PAGE)
    @Post('cancel')
    async cancel(
        @Req() req: any,
        @Body()
            body: {
            requestId: number;
            remark?: string;
        },
    ) {
        const operatorId = req.user?.userId;
        return this.service.cancelWithdrawal({ ...body, operatorId });
    }
}
