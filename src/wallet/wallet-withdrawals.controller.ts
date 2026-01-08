import { Body, Controller, Get, Post } from '@nestjs/common';
import { WalletWithdrawalsService } from './wallet-withdrawals.service';

/**
 * 提现接口（挂在 wallet 模块下）
 *
 * ⚠️ 你需要按项目现有方式自行加：
 * - JWT 鉴权
 * - 角色/权限控制（打手 / 客服 / 财务）
 */
@Controller('wallet/withdrawals')
export class WalletWithdrawalsController {
    constructor(private readonly service: WalletWithdrawalsService) {}

    /** 打手：申请提现 */
    @Post('apply')
    async apply(
        @Body()
            body: {
            userId: number;
            amount: number;
            idempotencyKey: string;
            remark?: string;
            channel?: 'MANUAL' | 'WECHAT';
        },
    ) {
        return this.service.applyWithdrawal(body);
    }

    /** 打手：我的提现记录 */
    @Get('mine')
    async mine(@Body() body: { userId: number }) {
        return this.service.listMine(body.userId);
    }

    /** 管理端：待审核列表 */
    @Get('pending')
    async pending() {
        return this.service.listPending();
    }

    /** 管理端：审批提现 */
    @Post('review')
    async review(
        @Body()
            body: {
            requestId: number;
            reviewerId: number;
            approve: boolean;
            reviewRemark?: string;
        },
    ) {
        return this.service.reviewWithdrawal(body);
    }
}
