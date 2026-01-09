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

    /**
     * 打手：申请提现
     * POST /wallet/withdrawals/apply
     */
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

    /**
     * 打手：我的提现记录
     * GET /wallet/withdrawals/mine
     *
     * ⚠️ 注意：GET 带 Body 并不标准，但你现有实现就是这样（先不大改）
     * 你后续可以改成 query 参数：mine?userId=xxx
     */
    @Get('mine')
    async mine(@Body() body: { userId: number }) {
        return this.service.listMine(body.userId);
    }

    /**
     * 管理端：待审核列表
     * GET /wallet/withdrawals/pending
     */
    @Get('pending')
    async pending() {
        return this.service.listPending();
    }

    /**
     * ✅ 管理端：全量记录（分页 + 筛选 + 打款字段展示用）
     * POST /wallet/withdrawals/list
     *
     * 说明：
     * - 用 POST 是为了便于扩展筛选条件（时间范围/模糊搜索等）
     * - 管理端页面将用它做“全部记录 + 状态筛选 + 打款结果字段展示”
     */
    @Post('list')
    async list(
        @Body()
            body: {
            page: number;
            pageSize: number;
            status?: string; // WithdrawalStatus，可选
            channel?: string; // WithdrawalChannel，可选
            userId?: number; // 可选：按用户筛
            requestNo?: string; // 可选：按单号模糊
            createdAtFrom?: string; // 可选：开始时间（ISO 字符串）
            createdAtTo?: string; // 可选：结束时间（ISO 字符串）
        },
    ) {
        return this.service.listAll(body);
    }

    /**
     * 管理端：审批提现
     * POST /wallet/withdrawals/review
     */
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
