import {
    Body,
    Controller,
    Get,
    Param,
    ParseIntPipe,
    Post,
    Query,
    Request,
    UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { AssignDispatchDto } from './dto/assign-dispatch.dto';
import { AcceptDispatchDto } from './dto/accept-dispatch.dto';
import { ArchiveDispatchDto } from './dto/archive-dispatch.dto';
import { CompleteDispatchDto } from './dto/complete-dispatch.dto';
import { QuerySettlementBatchDto } from './dto/query-settlement-batch.dto';
import { MarkPaidDto } from './dto/mark-paid.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class OrdersController {
    constructor(private readonly ordersService: OrdersService) {}

    /**
     * 创建订单
     */
    @Post('orders')
    createOrder(@Body() dto: CreateOrderDto, @Request() req: any) {
        return this.ordersService.createOrder(dto, req.user.userId);
    }

    /**
     * 订单列表（筛选）
     */
    @Get('orders')
    listOrders(@Query() query: QueryOrdersDto) {
        return this.ordersService.listOrders(query);
    }

    /**
     * 订单详情
     */
    @Get('orders/:id')
    getOrder(@Param('id', ParseIntPipe) id: number) {
        return this.ordersService.getOrderDetail(id);
    }

    /**
     * 派单 / 更新本轮参与者
     * - 仅当前 dispatch.status=WAIT_ASSIGN 允许
     */
    @Post('orders/:id/dispatch')
    assignDispatch(@Param('id', ParseIntPipe) orderId: number, @Body() dto: AssignDispatchDto, @Request() req: any) {
        return this.ordersService.assignOrUpdateDispatch(orderId, dto, req.user.userId);
    }

    /**
     * 陪玩接单（某个 dispatch）
     */
    @Post('orders/dispatch/:dispatchId/accept')
    acceptDispatch(@Param('dispatchId', ParseIntPipe) dispatchId: number, @Body() dto: AcceptDispatchDto, @Request() req: any) {
        return this.ordersService.acceptDispatch(dispatchId, req.user.userId, dto);
    }

    /**
     * 存单（ARCHIVED）
     * - 小时单：可传 deductMinutesOption
     * - 保底单：可传 progresses（每人 progressBaseWan）
     * - 存单会为这一轮生成结算明细（按你业务：存单也要按贡献结算）
     */
    @Post('orders/dispatch/:dispatchId/archive')
    archiveDispatch(@Param('dispatchId', ParseIntPipe) dispatchId: number, @Body() dto: ArchiveDispatchDto, @Request() req: any) {
        return this.ordersService.archiveDispatch(dispatchId, req.user.userId, dto);
    }

    /**
     * 结单（COMPLETED）——结单即自动结算落库
     */
    @Post('orders/dispatch/:dispatchId/complete')
    completeDispatch(@Param('dispatchId', ParseIntPipe) dispatchId: number, @Body() dto: CompleteDispatchDto, @Request() req: any) {
        return this.ordersService.completeDispatch(dispatchId, req.user.userId, dto);
    }

    /**
     * 批次结算查询（用于 admin 的体验三日 / 月度结算页面）
     */
    @Get('settlements/batches')
    querySettlementBatch(@Query() query: QuerySettlementBatchDto) {
        return this.ordersService.querySettlementBatch(query);
    }

    /**
     * 标记打款（按 settlementIds）
     */
    @Post('settlements/mark-paid')
    markPaid(@Body() dto: MarkPaidDto, @Request() req: any) {
        return this.ordersService.markSettlementsPaid(dto, req.user.userId);
    }

    /**
     * 陪玩查看自己的接单记录（基于 OrderParticipant）
     * - 这是你要求的“先默认支持”
     */
    @Get('me/orders/participations')
    myParticipations(@Request() req: any) {
        return this.ordersService.listMyParticipations(req.user.userId);
    }

    /**
     * 陪玩查看自己的结算记录（基于 OrderSettlement）
     */
    @Get('me/orders/settlements')
    mySettlements(@Request() req: any) {
        return this.ordersService.listMySettlements(req.user.userId);
    }
}
