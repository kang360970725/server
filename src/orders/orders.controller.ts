import {
    Body,
    Controller,
    Post,
    UseGuards,
    Request,
    ParseIntPipe,
    BadRequestException,
    Req,
    ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OrdersService } from './orders.service';
import { AdjustSettlementDto } from './dto/adjust-settlement.dto';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';

/**
 * Orders Controller（v0.1）
 * ✅ 统一使用 POST 接口
 * ✅ 所有数值参数（page/limit/id/...）统一转 number，避免 Prisma take/skip 报错
 */
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
    constructor(private readonly ordersService: OrdersService) {}

    /** 订单列表（管理端） */
    @Post('list')
    @UseGuards(PermissionsGuard)
    @Permissions('orders:list:page')
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

    /** 订单详情（管理端） */
    @Post('detail')
    @UseGuards(PermissionsGuard)
    @Permissions('orders:detail:page')
    async detail(@Body() body: any) {
        const id = Number(body.id);
        if (!id || Number.isNaN(id)) throw new BadRequestException('id 必须为数字');
        return this.ordersService.getOrderDetail(id);
    }

    /** 新建订单（管理端） */
    @Post('create')
    @UseGuards(PermissionsGuard)
    @Permissions('orders:list:page')
    async create(@Body() body: any, @Request() req: any) {
        const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
        return this.ordersService.createOrder(body, operatorId);
    }

    /** 取消订单（管理端） */
    @Post('cancel')
    @UseGuards(PermissionsGuard)
    @Permissions('orders:list:page')
    async cancel(@Body() body: any, @Request() req: any) {
        const id = Number(body.id);
        if (!id || Number.isNaN(id)) throw new BadRequestException('id 必须为数字');
        return this.ordersService.cancelOrder(id, req.user?.userId, body.remark);
    }

    /** 派单/重新派单（管理端） */
    @Post('dispatch')
    @UseGuards(PermissionsGuard)
    @Permissions('orders:list:page')
    async dispatch(@Body() body: any, @Request() req: any) {
        const orderId = Number(body.orderId);
        if (!orderId || Number.isNaN(orderId)) throw new BadRequestException('orderId 必须为数字');

        const playerIdsRaw = body.playerIds;
        if (!Array.isArray(playerIdsRaw)) throw new BadRequestException('playerIds 必须为数组');

        const playerIds = playerIdsRaw
            .map((x: any) => Number(x))
            .filter((x: number) => !Number.isNaN(x));

        if (playerIds.length < 1 || playerIds.length > 2) {
            throw new BadRequestException('playerIds 必须为 1~2 个');
        }

        return this.ordersService.assignDispatch(orderId, playerIds, req.user?.userId, body.remark);
    }

    /** 存单（管理端） */
    @Post('dispatch/archive')
    @UseGuards(PermissionsGuard)
    @Permissions('orders:detail:page')
    async archive(@Body() body: any, @Request() req: any) {
        const dispatchId = Number(body.dispatchId);
        if (!dispatchId || Number.isNaN(dispatchId)) throw new BadRequestException('dispatchId 必须为数字');
        return this.ordersService.archiveDispatch(dispatchId, req.user?.userId, body);
    }

    /** 结单（管理端） */
    @Post('dispatch/complete')
    @UseGuards(PermissionsGuard)
    @Permissions('orders:detail:page')
    async complete(@Body() body: any, @Request() req: any) {
        const dispatchId = Number(body.dispatchId);
        if (!dispatchId || Number.isNaN(dispatchId)) throw new BadRequestException('dispatchId 必须为数字');
        return this.ordersService.completeDispatch(dispatchId, req.user?.userId, body);
    }

    /** 修改实付金额（管理端） */
    @Post('update-paid-amount')
    @UseGuards(PermissionsGuard)
    @Permissions('orders:list:page')
    updatePaidAmount(@Body() body: any, @Request() req: any) {
        return this.ordersService.updatePaidAmount(
            Number(body.id),
            Number(body.paidAmount),
            req.user?.userId,
            body.remark,
        );
    }

    /** 更新参与者（管理端） */
    @Post('dispatch/update-participants')
    @UseGuards(PermissionsGuard)
    @Permissions('orders:list:page')
    updateParticipants(@Body() body: any, @Request() req: any) {
        const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
        const ids = Array.isArray(body.playerIds) ? body.playerIds : body.userIds;
        return this.ordersService.updateDispatchParticipants(
            {
                dispatchId: Number(body.dispatchId),
                playerIds: Array.isArray(ids)
                    ? ids.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
                    : [],
                remark: body.remark,
            },
            operatorId,
        );
    }

    /** 结算调整（管理端/财务） */
    @Post('settlements/adjust')
    @UseGuards(PermissionsGuard)
    @Permissions('settlements:monthly:page')
    adjustSettlement(@Body() dto: AdjustSettlementDto, @Req() req: any) {
        const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
        if (!operatorId) throw new ForbiddenException('未登录或登录已失效');
        return this.ordersService.adjustSettlementFinalEarnings(dto, operatorId);
    }

    /** 退款（管理端） */
    @Post('refund')
    @UseGuards(PermissionsGuard)
    @Permissions('orders:list:page')
    refund(@Body() body: { id: number; remark?: string }, @Req() req: any) {
        const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
        return this.ordersService.refundOrder(Number(body.id), operatorId, body.remark);
    }

    /** 订单编辑（管理端） */
    @Post('update')
    @UseGuards(PermissionsGuard)
    @Permissions('orders:list:page')
    update(@Body() dto: any, @Req() req: any) {
        const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
        return this.ordersService.updateOrderEditable(dto, operatorId);
    }

    /** 修改存单记录的保底进度（管理端） */
    @Post('dispatch/participant/update-progress')
    @UseGuards(PermissionsGuard)
    @Permissions('orders:list:page')
    async updateArchivedProgress(@Body() body: any, @Request() req: any) {
        const dispatchId = Number(body.dispatchId);
        const participantId = Number(body.participantId);
        const progressBaseWan = body.progressBaseWan;

        if (!dispatchId || Number.isNaN(dispatchId)) throw new BadRequestException('dispatchId 必须为数字');
        if (!participantId || Number.isNaN(participantId)) throw new BadRequestException('participantId 必须为数字');

        const n = Number(progressBaseWan);
        if (!Number.isFinite(n)) throw new BadRequestException('progressBaseWan 非法');

        return this.ordersService.updateArchivedParticipantProgress(
            dispatchId,
            participantId,
            n,
            req.user?.userId,
            body.remark,
        );
    }

    /** ====================== 陪玩端（不应被管理端 orders 权限误伤） ====================== */

    /** 陪玩接单（陪玩端） */
    @Post('dispatch/accept')
    @UseGuards(PermissionsGuard)
    @Permissions('staff:my-orders:page')
    async accept(@Body() body: any, @Request() req: any) {
        const dispatchId = Number(body.dispatchId);
        if (!dispatchId || Number.isNaN(dispatchId)) throw new BadRequestException('dispatchId 必须为数字');
        return this.ordersService.acceptDispatch(dispatchId, req.user?.userId, body.remark);
    }

    /** 陪玩拒单（陪玩端） */
    @Post('dispatch/reject')
    @UseGuards(PermissionsGuard)
    @Permissions('staff:my-orders:page')
    async reject(@Body() body: any, @Request() req: any) {
        const dispatchId = Number(body.dispatchId);
        if (!dispatchId || Number.isNaN(dispatchId)) throw new BadRequestException('dispatchId 必须为数字');
        const reason = String(body.reason ?? '').trim();
        if (!reason) throw new BadRequestException('reason 必填');
        return this.ordersService.rejectDispatch(dispatchId, req.user?.userId, reason);
    }

    /** 我的接单记录 / 工作台（陪玩端） */
    @Post('my-dispatches')
    @UseGuards(PermissionsGuard)
    @Permissions('staff:my-orders:page')
    async myDispatches(@Body() body: any, @Request() req: any) {
        const page = Math.max(1, Number(body.page ?? 1));
        const limit = Math.min(100, Math.max(1, Number(body.limit ?? 20)));
        const userId = Number(req.user?.userId);

        return this.ordersService.listMyDispatches({
            userId,
            page,
            limit,
            status: body.status,
            mode: body.mode, // ✅ workbench | history
        });
    }

    /** 我的工作台统计（陪玩端） */
    @Post('my/stats')
    @UseGuards(PermissionsGuard)
    @Permissions('staff:workbench:page')
    myStats(@Req() req: any) {
        const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
        return this.ordersService.getMyWorkbenchStats(userId);
    }
}
