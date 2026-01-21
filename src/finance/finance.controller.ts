import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FinanceService } from './finance.service';
import { ReconcileSummaryDto } from './dto/reconcile-summary.dto';
import { ReconcileOrdersDto } from './dto/reconcile-orders.dto';
import { ReconcileOrderDetailDto } from './dto/reconcile-order-detail.dto';

@Controller('finance/reconcile')
@UseGuards(JwtAuthGuard)
export class FinanceController {
    constructor(private readonly financeService: FinanceService) {}

    /**
     * 财务核账：总览统计（按“收款时间”口径）
     * - 收入口径：isPaid=true 的 paidAmount
     * - 统计时间：Order.paymentTime（收款确认时间）
     * - 退款完成：必须存在冲正流水（WalletTransaction.bizType=REFUND_REVERSAL 或 reversalOfTxId 非空）
     */
    @Post('summary')
    async summary(@Body() dto: ReconcileSummaryDto, @Req() req: any) {
        return this.financeService.summary(req?.user, dto, req);
    }

    /**
     * 财务核账：每单一列
     * ✅ 已按你的确认修复：默认展示全部订单（不论状态/是否退款/是否付款），时间按 openedAt
     * - 支持：按订单号(autoSerial) / 按打手(userId) 筛选
     */
    @Post('orders')
    async orders(@Body() dto: ReconcileOrdersDto, @Req() req: any) {
        return this.financeService.orders(req?.user, dto, req);
    }

    /**
     * 财务核账：单订单抽查详情
     * - 订单基础 + 结算明细 + 关联钱包流水（含冲正链路）
     */
    @Post('order-detail')
    async orderDetail(@Body() dto: ReconcileOrderDetailDto, @Req() req: any) {
        return this.financeService.orderDetail(req?.user, dto, req);
    }

    /**
     * 财务核账：打手流水查询（只读审计）
     * - 仅财务/超管可用（权限在 service 内严格校验）
     * - 路径：POST /finance/reconcile/player/transactions
     */
    @Post('player/transactions')
    async playerTransactions(
        @Body()
            dto: {
            playerId: number;
            startAt?: string;
            endAt?: string;
            page?: number;
            pageSize?: number;
        },
        @Req() req: any,
    ) {
        return this.financeService.playerTransactions(req?.user, dto, req);
    }
}
