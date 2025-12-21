// src/orders/orders.controller.ts
import {
    Body,
    Controller,
    Post,
    UseGuards,
    Request,
    ParseIntPipe,
    BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrdersService } from './orders.service';

/**
 * Orders Controller（v0.1）
 * ✅ 统一使用 POST 接口
 * ✅ 所有数值参数（page/limit/id/...）统一转 number，避免 Prisma take/skip 报错
 */
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
    constructor(private readonly ordersService: OrdersService) {}

    /**
     * 订单列表
     * POST /orders/list
     * body: { page?, limit?, serial?, status?, customerGameId?, projectId?, dispatcherId?, playerId? }
     */
    @Post('list')
    async list(@Body() body: any) {
        const page = Math.max(1, Number(body.page ?? 1));
        const limit = Math.min(100, Math.max(1, Number(body.limit ?? 20)));

        return this.ordersService.listOrders({
            page,
            limit,
            serial: body.serial,
            status: body.status,
            customerGameId: body.customerGameId,
            projectId: body.projectId != null ? Number(body.projectId) : undefined,
            dispatcherId: body.dispatcherId != null ? Number(body.dispatcherId) : undefined,
            playerId: body.playerId != null ? Number(body.playerId) : undefined,
        });
    }

    /**
     * 订单详情
     * POST /orders/detail
     * body: { id }
     */
    @Post('detail')
    async detail(@Body() body: any) {
        const id = Number(body.id);
        if (!id || Number.isNaN(id)) throw new BadRequestException('id 必须为数字');
        return this.ordersService.getOrderDetail(id);
    }

    /**
     * 新建订单
     * POST /orders/create
     * body: CreateOrderDto（v0.1 先用 any，后续可补 DTO + class-validator）
     */
    @Post('create')
    async create(@Body() body: any, @Request() req: any) {
        const operatorId = req.user?.userId;
        return this.ordersService.createOrder(body, operatorId);
    }

    /**
     * 取消订单（预留：v0.1 你如果还没实现 service，可以先不接）
     * POST /orders/cancel
     * body: { id, remark? }
     */
    @Post('cancel')
    async cancel(@Body() body: any, @Request() req: any) {
        const id = Number(body.id);
        if (!id || Number.isNaN(id)) throw new BadRequestException('id 必须为数字');
        return this.ordersService.cancelOrder(id, req.user?.userId, body.remark);
    }

    /**
     * 派单 / 重新派单（创建新一轮 dispatch）
     * POST /orders/dispatch
     * body: { orderId, playerIds: number[], remark? }
     */
    @Post('dispatch')
    async dispatch(@Body() body: any, @Request() req: any) {
        const orderId = Number(body.orderId);
        if (!orderId || Number.isNaN(orderId)) throw new BadRequestException('orderId 必须为数字');

        const playerIdsRaw = body.playerIds;
        if (!Array.isArray(playerIdsRaw)) throw new BadRequestException('playerIds 必须为数组');

        const playerIds = playerIdsRaw.map((x: any) => Number(x)).filter((x: number) => !Number.isNaN(x));
        if (playerIds.length < 1 || playerIds.length > 2) {
            throw new BadRequestException('playerIds 必须为 1~2 个');
        }

        return this.ordersService.assignDispatch(orderId, playerIds, req.user?.userId, body.remark);
    }

    /**
     * 陪玩接单（单个参与者确认）
     * POST /orders/dispatch/accept
     * body: { dispatchId, remark? }
     */
    @Post('dispatch/accept')
    async accept(@Body() body: any, @Request() req: any) {
        const dispatchId = Number(body.dispatchId);
        if (!dispatchId || Number.isNaN(dispatchId)) throw new BadRequestException('dispatchId 必须为数字');
        return this.ordersService.acceptDispatch(dispatchId, req.user?.userId, body.remark);
    }

    /**
     * 存单（本轮自动结算并落库）
     * POST /orders/dispatch/archive
     * body: { dispatchId, deductMinutesOption?, remark?, progresses? }
     *
     * progresses: [{ userId, progressBaseWan }]  // 保底单：每个陪玩可填写本轮已打保底（万，可为负）
     */
    @Post('dispatch/archive')
    async archive(@Body() body: any, @Request() req: any) {
        const dispatchId = Number(body.dispatchId);
        if (!dispatchId || Number.isNaN(dispatchId)) throw new BadRequestException('dispatchId 必须为数字');

        // 交给 service 做更严谨校验（例如扣除时间枚举、progresses 结构）
        return this.ordersService.archiveDispatch(dispatchId, req.user?.userId, body);
    }

    /**
     * 结单（本轮自动结算并落库）
     * POST /orders/dispatch/complete
     * body: { dispatchId, deductMinutesOption?, remark?, progresses? }
     */
    @Post('dispatch/complete')
    async complete(@Body() body: any, @Request() req: any) {
        const dispatchId = Number(body.dispatchId);
        if (!dispatchId || Number.isNaN(dispatchId)) throw new BadRequestException('dispatchId 必须为数字');

        return this.ordersService.completeDispatch(dispatchId, req.user?.userId, body);
    }

    /**
     * 我的接单记录（给陪玩查看自己参与的订单）
     * POST /orders/my-dispatches
     * body: { page?, limit?, status? }
     *
     * ✅ 后续你可以在前端做“陪玩端/个人中心”使用
     */
    @Post('my-dispatches')
    async myDispatches(@Body() body: any, @Request() req: any) {
        const page = Math.max(1, Number(body.page ?? 1));
        const limit = Math.min(100, Math.max(1, Number(body.limit ?? 20)));
        const userId = req.user?.userId;

        return this.ordersService.listMyDispatches({
            userId,
            page,
            limit,
            status: body.status,
        });
    }

    @Post('update-paid-amount')
    updatePaidAmount(@Body() body: any, @Request() req: any) {
        return this.ordersService.updatePaidAmount(
            Number(body.id),
            Number(body.paidAmount),
            req.user?.userId,
            body.remark,
        );
    }

    @Post('dispatch/update-participants')
    updateParticipants(@Body() body: any, @Request() req: any) {
        return this.ordersService.updateDispatchParticipants(
            Number(body.dispatchId),
            (body.playerIds || []).map((x: any) => Number(x)),
            req.user?.userId,
            body.remark,
        );
    }
}
