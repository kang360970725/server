import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
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
        },
    ) {
        const userId = req.user?.userId; // 以你 jwt 注入结构为准
        return this.service.applyWithdrawal({ ...body, userId });
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
    async pending() {
        return this.service.listPending();
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
}
