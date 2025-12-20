import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { QueryOrdersDto } from './dto/query-orders.dto';
import { AssignDispatchDto } from './dto/assign-dispatch.dto';
import { AcceptDispatchDto } from './dto/accept-dispatch.dto';
import { ArchiveDispatchDto } from './dto/archive-dispatch.dto';
import { CompleteDispatchDto } from './dto/complete-dispatch.dto';
import { QuerySettlementBatchDto } from './dto/query-settlement-batch.dto';
import { MarkPaidDto } from './dto/mark-paid.dto';
import { BillingMode, DispatchStatus, OrderStatus, PaymentStatus } from '@prisma/client';

/**
 * OrdersService v0.1
 *
 * 关键业务约束（v0.1）：
 * 1) 金额字段（应收/实付）创建后不可修改 —— v0.1 暂不提供 update 接口
 * 2) 派单参与者只能在 dispatch.status=WAIT_ASSIGN 时修改
 * 3) “已接单”= 本轮所有参与者 acceptedAt 都非空
 * 4) 存单/结单会为本轮生成结算明细（OrderSettlement 落库）
 *    - 存单：按进度比例计算本轮应结收益（保底单/小时单）
 *    - 结单：结算“剩余部分”或“全量”（小时单默认全量；保底单默认结剩余）
 * 5) 小时单时长计算：
 *    - 计时区间：acceptedAllAt -> archivedAt/completedAt
 *    - 扣除 deductMinutesValue
 *    - 折算规则：整数小时 + 分钟段(0/0.5/1)，分钟 <15=0, 15~45=0.5, >45=1
 */
@Injectable()
export class OrdersService {
    constructor(private prisma: PrismaService) {}

    // -----------------------------
    // 1) 创建订单
    // -----------------------------

    async createOrder(dto: CreateOrderDto, dispatcherId: number) {
        const project = await this.prisma.gameProject.findUnique({ where: { id: dto.projectId } });
        if (!project) throw new NotFoundException('项目不存在');

        // 默认客服分佣：体验单为 0，其他为 0.01
        const defaultCsRate = project.type === 'EXPERIENCE' ? 0 : 0.01;

        // 默认推广分佣：有 inviter 才默认 0.05
        const defaultInviteRate = dto.inviter ? 0.05 : 0;

        // 默认俱乐部抽成：订单级优先，其次项目默认；允许为空（表示未来按评级等扩展）
        const clubRate = dto.customClubRate ?? project.clubRate ?? null;

        // 项目快照（防止项目改价/改抽成后影响历史订单）
        const projectSnapshot = {
            id: project.id,
            name: project.name,
            type: project.type,
            billingMode: project.billingMode,
            price: project.price,
            baseAmount: project.baseAmount ?? null,
            clubRate: project.clubRate ?? null,
            coverImage: project.coverImage ?? null,
        };

        const serial = await this.generateOrderSerial();

        const order = await this.prisma.order.create({
            data: {
                autoSerial: serial,
                receivableAmount: dto.receivableAmount,
                paidAmount: dto.paidAmount,
                orderTime: dto.orderTime ? new Date(dto.orderTime) : null,
                paymentTime: dto.paymentTime ? new Date(dto.paymentTime) : null,
                openedAt: new Date(),
                baseAmountWan: dto.baseAmountWan ?? null,

                projectId: project.id,
                projectSnapshot: projectSnapshot as any,

                customerGameId: dto.customerGameId ?? null,

                dispatcherId,

                csRate: dto.csRate ?? defaultCsRate,
                inviteRate: dto.inviteRate ?? defaultInviteRate,
                inviter: dto.inviter ?? null,

                customClubRate: dto.customClubRate ?? null,
                clubRate: clubRate ?? null,

                status: OrderStatus.WAIT_ASSIGN,
            },
            include: {
                project: true,
                currentDispatch: true,
            },
        });

        await this.logOrderAction(dispatcherId, order.id, 'CREATE_ORDER', {
            autoSerial: order.autoSerial,
            projectId: order.projectId,
            paidAmount: order.paidAmount,
        });

        return order;
    }

    /**
     * 生成订单序列号：YYYYMMDD-0001
     * v0.1：用 DB 查询当日最大序号后 +1
     */
    private async generateOrderSerial(): Promise<string> {
        const now = new Date();
        const yyyy = now.getFullYear().toString();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const prefix = `${yyyy}${mm}${dd}-`;

        // 注意：并发极端情况下可能撞号（开发期可接受）
        // 如要强一致，可引入专用序列表或在事务/锁上做增强。
        const last = await this.prisma.order.findFirst({
            where: { autoSerial: { startsWith: prefix } },
            orderBy: { autoSerial: 'desc' },
            select: { autoSerial: true },
        });

        let next = 1;
        if (last?.autoSerial) {
            const suffix = last.autoSerial.replace(prefix, '');
            const n = parseInt(suffix, 10);
            if (!Number.isNaN(n)) next = n + 1;
        }

        return `${prefix}${String(next).padStart(4, '0')}`;
    }

    // -----------------------------
    // 2) 列表/详情
    // -----------------------------

    async listOrders(query: QueryOrdersDto) {
        const page = query.page ?? 1;
        const limit = query.limit ?? 10;
        const skip = (page - 1) * limit;

        const where: any = {};

        if (query.serial) {
            where.autoSerial = { contains: query.serial };
        }
        if (query.projectId) {
            where.projectId = query.projectId;
        }
        if (query.status) {
            where.status = query.status as any;
        }
        if (query.dispatcherId) {
            where.dispatcherId = query.dispatcherId;
        }
        if (query.customerGameId) {
            where.customerGameId = { contains: query.customerGameId };
        }

        // 陪玩筛选：通过当前/历史 participant 反查订单
        if (query.playerId) {
            where.dispatches = {
                some: {
                    participants: {
                        some: { userId: query.playerId },
                    },
                },
            };
        }

        const [data, total] = await Promise.all([
            this.prisma.order.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' },
                include: {
                    project: true,
                    dispatcher: { select: { id: true, name: true, phone: true } },
                    currentDispatch: {
                        include: {
                            participants: {
                                include: { user: { select: { id: true, name: true, phone: true } } },
                            },
                        },
                    },
                },
            }),
            this.prisma.order.count({ where }),
        ]);

        return {
            data,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    }

    async getOrderDetail(orderId: number) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                project: true,
                dispatcher: { select: { id: true, name: true, phone: true } },
                dispatches: {
                    orderBy: { round: 'asc' },
                    include: {
                        participants: { include: { user: { select: { id: true, name: true, phone: true } } } },
                        settlements: true,
                    },
                },
                settlements: {
                    orderBy: { settledAt: 'desc' },
                    include: { user: { select: { id: true, name: true, phone: true } } },
                },
            },
        });

        if (!order) throw new NotFoundException('订单不存在');
        return order;
    }

    // -----------------------------
    // 3) 派单/更新参与者
    // -----------------------------

    /**
     * 派单策略（v0.1）：
     * - 如果订单没有 currentDispatch：创建 round=1 的 dispatch（WAIT_ASSIGN -> WAIT_ACCEPT）
     * - 如果有 currentDispatch 且 status=WAIT_ASSIGN：允许更新参与者
     * - 如果 currentDispatch 不是 WAIT_ASSIGN：不允许修改参与者
     */
    async assignOrUpdateDispatch(orderId: number, dto: AssignDispatchDto, operatorId: number) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { currentDispatch: true, project: true },
        });
        if (!order) throw new NotFoundException('订单不存在');

        // 若已退款等终态，可禁用派单（你后续可按业务扩展）
        if (order.status === OrderStatus.REFUNDED) {
            throw new ForbiddenException('已退款订单不可派单');
        }

        // 如果有 currentDispatch
        if (order.currentDispatchId) {
            const dispatch = await this.prisma.orderDispatch.findUnique({
                where: { id: order.currentDispatchId },
                include: { participants: true },
            });
            if (!dispatch) throw new NotFoundException('当前派单批次不存在');

            if (dispatch.status !== DispatchStatus.WAIT_ASSIGN) {
                throw new ForbiddenException('当前状态不可修改参与者（仅待派单可修改）');
            }

            // 更新参与者：简单策略 = 删除后重建（仅 WAIT_ASSIGN 阶段，没有历史价值）
            await this.prisma.orderParticipant.deleteMany({ where: { dispatchId: dispatch.id } });
            await this.prisma.orderParticipant.createMany({
                data: dto.playerIds.map((uid) => ({
                    dispatchId: dispatch.id,
                    userId: uid,
                    acceptedAt: null,
                    contributionAmount: 0,
                    progressBaseWan: null,
                    isActive: true,
                })),
            });

            // 将派单状态推进到 WAIT_ACCEPT（表示已经指派了人）
            const updatedDispatch = await this.prisma.orderDispatch.update({
                where: { id: dispatch.id },
                data: {
                    status: DispatchStatus.WAIT_ACCEPT,
                    assignedAt: new Date(),
                    remark: dto.remark ?? dispatch.remark ?? null,
                },
                include: {
                    participants: { include: { user: { select: { id: true, name: true, phone: true } } } },
                },
            });

            const updatedOrder = await this.prisma.order.update({
                where: { id: order.id },
                data: {
                    status: OrderStatus.WAIT_ACCEPT,
                },
            });

            await this.logOrderAction(operatorId, order.id, 'ASSIGN_DISPATCH', {
                dispatchId: updatedDispatch.id,
                players: dto.playerIds,
            });

            return { order: updatedOrder, dispatch: updatedDispatch };
        }

        // 如果没有 currentDispatch：创建 round=1
        const lastDispatch = await this.prisma.orderDispatch.findFirst({
            where: { orderId },
            orderBy: { round: 'desc' },
            select: { round: true },
        });
        const round = (lastDispatch?.round ?? 0) + 1;

        const dispatch = await this.prisma.orderDispatch.create({
            data: {
                orderId,
                round,
                status: DispatchStatus.WAIT_ACCEPT,
                assignedAt: new Date(),
                remark: dto.remark ?? null,
                participants: {
                    create: dto.playerIds.map((uid) => ({
                        userId: uid,
                        isActive: true,
                    })),
                },
            },
            include: {
                participants: { include: { user: { select: { id: true, name: true, phone: true } } } },
            },
        });

        await this.prisma.order.update({
            where: { id: orderId },
            data: {
                currentDispatchId: dispatch.id,
                status: OrderStatus.WAIT_ACCEPT,
            },
        });

        await this.logOrderAction(operatorId, orderId, 'CREATE_DISPATCH', {
            dispatchId: dispatch.id,
            round,
            players: dto.playerIds,
        });

        return dispatch;
    }

    // -----------------------------
    // 4) 接单
    // -----------------------------

    async acceptDispatch(dispatchId: number, userId: number, dto: AcceptDispatchDto) {
        const dispatch = await this.prisma.orderDispatch.findUnique({
            where: { id: dispatchId },
            include: {
                order: true,
                participants: true,
            },
        });

        if (!dispatch) throw new NotFoundException('派单批次不存在');

        this.ensureDispatchStatus(dispatch, [DispatchStatus.WAIT_ACCEPT, DispatchStatus.ACCEPTED], '当前状态不可接单');

        const participant = dispatch.participants.find((p) => p.userId === userId);
        if (!participant) throw new ForbiddenException('你不是该订单的参与者');

        if (participant.acceptedAt) {
            // 幂等：已接单直接返回
            return this.getDispatchWithParticipants(dispatchId);
        }

        await this.prisma.orderParticipant.update({
            where: { id: participant.id },
            data: { acceptedAt: new Date() },
        });

        // 判断是否全员接单完成
        const refreshed = await this.prisma.orderDispatch.findUnique({
            where: { id: dispatchId },
            include: { participants: true, order: true },
        });
        if (!refreshed) throw new NotFoundException('派单批次不存在');

        const allAccepted = refreshed.participants.length > 0 && refreshed.participants.every((p) => !!p.acceptedAt);

        if (allAccepted && refreshed.status !== DispatchStatus.ACCEPTED) {
            await this.prisma.orderDispatch.update({
                where: { id: dispatchId },
                data: {
                    status: DispatchStatus.ACCEPTED,
                    acceptedAllAt: new Date(),
                },
            });

            await this.prisma.order.update({
                where: { id: refreshed.orderId },
                data: { status: OrderStatus.ACCEPTED },
            });
        }

        await this.logOrderAction(userId, refreshed.orderId, 'ACCEPT_DISPATCH', {
            dispatchId,
            remark: dto.remark ?? null,
        });

        return this.getDispatchWithParticipants(dispatchId);
    }

    private async getDispatchWithParticipants(dispatchId: number) {
        return this.prisma.orderDispatch.findUnique({
            where: { id: dispatchId },
            include: {
                participants: { include: { user: { select: { id: true, name: true, phone: true } } } },
                order: { select: { id: true, autoSerial: true, status: true } },
            },
        });
    }

    // -----------------------------
    // 5) 存单（ARCHIVED）——本轮生成结算明细（按进度比例）
    // -----------------------------

    async archiveDispatch(dispatchId: number, operatorId: number, dto: ArchiveDispatchDto) {
        const dispatch = await this.prisma.orderDispatch.findUnique({
            where: { id: dispatchId },
            include: {
                order: { include: { project: true } },
                participants: true,
            },
        });
        if (!dispatch) throw new NotFoundException('派单批次不存在');

        this.ensureDispatchStatus(dispatch, [DispatchStatus.ACCEPTED], '只有已接单的订单才允许存单');

        const now = new Date();

        // 1) 写入 progress（保底单）与扣时（小时单）
        await this.applyProgressAndDeduct(dispatch, dto);

        // 2) 小时单：计算本轮已计费时长并落库
        const billingResult = await this.computeAndPersistBillingHours(dispatchId, 'ARCHIVE', dto.deductMinutesOption);

        // 3) 更新 dispatch 状态为 ARCHIVED
        await this.prisma.orderDispatch.update({
            where: { id: dispatchId },
            data: {
                status: DispatchStatus.ARCHIVED,
                archivedAt: now,
                remark: dto.remark ?? dispatch.remark ?? null,
                // billingResult 已在 computeAndPersistBillingHours 中落库
            },
        });

        // 4) 更新订单状态为 ARCHIVED（允许再次派单）
        await this.prisma.order.update({
            where: { id: dispatch.orderId },
            data: { status: OrderStatus.ARCHIVED },
        });

        // 5) 生成结算明细（本轮）
        await this.createSettlementsForDispatch({
            orderId: dispatch.orderId,
            dispatchId,
            mode: 'ARCHIVE',
        });

        await this.logOrderAction(operatorId, dispatch.orderId, 'ARCHIVE_DISPATCH', {
            dispatchId,
            billing: billingResult,
        });

        return this.getOrderDetail(dispatch.orderId);
    }

    // -----------------------------
    // 6) 结单（COMPLETED）——结单即自动结算落库
    // -----------------------------

    async completeDispatch(dispatchId: number, operatorId: number, dto: CompleteDispatchDto) {
        const dispatch = await this.prisma.orderDispatch.findUnique({
            where: { id: dispatchId },
            include: {
                order: { include: { project: true } },
                participants: true,
            },
        });
        if (!dispatch) throw new NotFoundException('派单批次不存在');

        this.ensureDispatchStatus(dispatch, [DispatchStatus.ACCEPTED], '只有已接单的订单才允许结单');

        const now = new Date();

        // 1) 写入 progress（可选）
        await this.applyProgressAndDeduct(dispatch, dto);

        // 2) 小时单：计算本轮计费时长并落库
        const billingResult = await this.computeAndPersistBillingHours(dispatchId, 'COMPLETE', dto.deductMinutesOption);

        // 3) 更新 dispatch 状态为 COMPLETED
        await this.prisma.orderDispatch.update({
            where: { id: dispatchId },
            data: {
                status: DispatchStatus.COMPLETED,
                completedAt: now,
                remark: dto.remark ?? dispatch.remark ?? null,
            },
        });

        // 4) 更新订单状态为 COMPLETED
        await this.prisma.order.update({
            where: { id: dispatch.orderId },
            data: { status: OrderStatus.COMPLETED },
        });

        // 5) 生成结算明细（本轮）
        await this.createSettlementsForDispatch({
            orderId: dispatch.orderId,
            dispatchId,
            mode: 'COMPLETE',
        });

        await this.logOrderAction(operatorId, dispatch.orderId, 'COMPLETE_DISPATCH', {
            dispatchId,
            billing: billingResult,
        });

        return this.getOrderDetail(dispatch.orderId);
    }

    /**
     * 写入保底进度 / 扣时选项
     * - 保底单：写 participants.progressBaseWan（允许负数）
     * - 小时单：仅记录 deductMinutesOption（实际计算在 computeAndPersistBillingHours）
     */
    private async applyProgressAndDeduct(
        dispatch: any,
        dto: { progresses?: Array<{ userId: number; progressBaseWan?: number }>; deductMinutesOption?: string },
    ) {
        // 写保底进度（如果传了）
        if (dto.progresses && dto.progresses.length > 0) {
            const map = new Map<number, number | null>();
            for (const p of dto.progresses) {
                map.set(p.userId, p.progressBaseWan ?? null);
            }

            for (const part of dispatch.participants) {
                if (map.has(part.userId)) {
                    await this.prisma.orderParticipant.update({
                        where: { id: part.id },
                        data: { progressBaseWan: map.get(part.userId) },
                    });
                }
            }
        }

        // deductMinutesOption 暂不直接落库到 dispatch（由 computeAndPersistBillingHours 统一处理并写入 value）
        // 因为不同动作（存单/结单）都要保证写入一致逻辑
    }

    //便捷函数
    private ensureDispatchStatus(dispatch: { status: DispatchStatus }, allowed: DispatchStatus[], message: string) {
        const allow = new Set<DispatchStatus>(allowed);
        if (!allow.has(dispatch.status)) throw new ForbiddenException(message);
    }

    /**
     * 小时单：计算并落库 billableMinutes / billableHours
     * - 计时：acceptedAllAt -> archivedAt / completedAt（以 action 来决定终点）
     * - 扣时：deductMinutesValue（10/20/.../60）
     */
    private async computeAndPersistBillingHours(
        dispatchId: number,
        action: 'ARCHIVE' | 'COMPLETE',
        deductMinutesOption?: string,
    ) {
        const dispatch = await this.prisma.orderDispatch.findUnique({
            where: { id: dispatchId },
            include: { order: { include: { project: true } } },
        });
        if (!dispatch) throw new NotFoundException('派单批次不存在');

        const billingMode = dispatch.order.project.billingMode;

        // 只有小时单才计算
        if (billingMode !== BillingMode.HOURLY) return null;

        if (!dispatch.acceptedAllAt) {
            // 正常不会发生：小时单要计算时长必须全员已接单
            throw new BadRequestException('小时单缺少全员接单时间，无法计算时长');
        }

        const endTime =
            action === 'ARCHIVE'
                ? new Date() // 存单时刻
                : new Date(); // 结单时刻

        const deductValue = this.mapDeductMinutesValue(deductMinutesOption);

        const rawMinutes = Math.max(0, Math.floor((endTime.getTime() - dispatch.acceptedAllAt.getTime()) / 60000));
        const effectiveMinutes = Math.max(0, rawMinutes - deductValue);

        const billableHours = this.minutesToBillableHours(effectiveMinutes);

        await this.prisma.orderDispatch.update({
            where: { id: dispatchId },
            data: {
                deductMinutes: deductMinutesOption as any,
                deductMinutesValue: deductValue || null,
                billableMinutes: effectiveMinutes,
                billableHours,
            },
        });

        return {
            rawMinutes,
            deductValue,
            effectiveMinutes,
            billableHours,
        };
    }

    /**
     * 扣时选项映射为分钟数
     */
    private mapDeductMinutesValue(option?: string): number {
        switch (option) {
            case 'M10': return 10;
            case 'M20': return 20;
            case 'M30': return 30;
            case 'M40': return 40;
            case 'M50': return 50;
            case 'M60': return 60;
            default: return 0;
        }
    }

    /**
     * 分钟 -> 计费小时（你的规则）
     * - 整数小时正常计
     * - 余分钟：<15=0, 15~45=0.5, >45=1
     * - totalMinutes < 15 => 0
     */
    private minutesToBillableHours(totalMinutes: number): number {
        if (totalMinutes < 15) return 0;

        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;

        let extra = 0;
        if (minutes < 15) extra = 0;
        else if (minutes <= 45) extra = 0.5;
        else extra = 1;

        return hours + extra;
    }

    // -----------------------------
    // 7) 生成结算明细（核心）
    // -----------------------------

    /**
     * 结算策略（v0.1）：
     * 1) 订单级费用拆分：
     *    playerPool = paidAmount - clubEarnings - csEarnings - inviteEarnings
     *
     * 2) 分配规则：
     *    - v0.1 默认均分（你已确认）
     *    - 存单（ARCHIVE）：
     *        保底单：按 progress/base 比例结算这一轮
     *        小时单：按本轮 billableHours / billableHoursFull?（v0.1 没“总小时”，所以存单用“本轮小时”直接视为本轮产出）
     *    - 结单（COMPLETE）：
     *        小时单：默认结算剩余全部（等价全量）
     *        保底单：默认结算“剩余比例”（1 - 已存单累计比例），避免重复结算
     *
     * 3) 多轮派单：
     *    存单允许多轮，每轮都会生成一批 settlement
     */
    private async createSettlementsForDispatch(params: { orderId: number; dispatchId: number; mode: 'ARCHIVE' | 'COMPLETE' }) {
        const { orderId, dispatchId, mode } = params;

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                project: true,
                dispatches: {
                    include: {
                        participants: true,
                    },
                },
            },
        });
        if (!order) throw new NotFoundException('订单不存在');

        const dispatch = await this.prisma.orderDispatch.findUnique({
            where: { id: dispatchId },
            include: {
                participants: true,
            },
        });
        if (!dispatch) throw new NotFoundException('派单批次不存在');

        // 参与者（v0.1：默认 1~2 人）
        const participants = dispatch.participants;
        if (!participants || participants.length === 0) throw new BadRequestException('派单批次没有参与者，无法结算');

        // 订单级分摊：俱乐部/客服/推广
        const clubRate = order.customClubRate ?? order.clubRate ?? null; // clubRate 已在创建时落库
        const csRate = order.csRate ?? 0;
        const inviteRate = order.inviteRate ?? 0;

        const clubEarnings = clubRate ? order.paidAmount * clubRate : 0;
        const csEarningsTotal = csRate ? order.paidAmount * csRate : 0;
        const inviteEarningsTotal = (order.inviter && inviteRate) ? order.paidAmount * inviteRate : 0;

        const playerPool = order.paidAmount - clubEarnings - csEarningsTotal - inviteEarningsTotal;

        // 结算类型：体验/福袋 = EXPERIENCE，否则 REGULAR（用于批次结算页面）
        const settlementType = (order.project.type === 'EXPERIENCE' || order.project.type === 'LUCKY_BAG')
            ? 'EXPERIENCE'
            : 'REGULAR';

        // 计算本轮应该结算的比例 ratio
        const ratio = await this.computeDispatchRatio(order, dispatch, mode);

        // 本轮陪玩总收益
        const dispatchPlayerTotal = playerPool * ratio;

        // v0.1：均分
        const each = participants.length > 0 ? dispatchPlayerTotal / participants.length : 0;

        // 写入 settlement（一人一条）
        // 为避免重复生成：如果这个 dispatch 已经有 settlement，就直接拒绝（幂等保护）
        const existing = await this.prisma.orderSettlement.findFirst({
            where: { orderId, dispatchId },
            select: { id: true },
        });
        if (existing) {
            throw new BadRequestException('该派单批次已生成结算记录，禁止重复结算');
        }

        await this.prisma.$transaction(async (tx) => {
            for (const p of participants) {
                await tx.orderSettlement.create({
                    data: {
                        orderId,
                        dispatchId,
                        userId: p.userId,
                        settlementType,
                        calculatedEarnings: each,
                        manualAdjustment: 0,
                        finalEarnings: each,
                        clubEarnings: clubEarnings ? clubEarnings * ratio : null,
                        csEarnings: csEarningsTotal ? csEarningsTotal * ratio : null,
                        inviteEarnings: inviteEarningsTotal ? inviteEarningsTotal * ratio : null,
                        paymentStatus: PaymentStatus.UNPAID,
                    },
                });
            }

            // 同时把 order 上的汇总字段落一下（便于对账）
            await tx.order.update({
                where: { id: orderId },
                data: {
                    clubEarnings,
                    clubRate: clubRate ?? null,
                    totalPlayerEarnings: playerPool,
                },
            });
        });

        // 审计日志（必须记录）
        await this.logOrderAction(order.dispatcherId, orderId, mode === 'ARCHIVE' ? 'SETTLE_ARCHIVE' : 'SETTLE_COMPLETE', {
            dispatchId,
            ratio,
            playerPool,
            dispatchPlayerTotal,
            each,
        });

        return true;
    }

    /**
     * 计算本轮应结算比例 ratio（0~1 或允许负数）
     *
     * 保底单（GUARANTEED）：
     * - ARCHIVE：ratio = (本轮 progressBaseWan 之和) / baseAmountWan
     * - COMPLETE：ratio = 1 - 已存单累计ratio（避免重复结算）
     *
     * 小时单（HOURLY）：
     * - v0.1：没有总小时概念（你要求不手填）
     * - ARCHIVE：ratio 直接按 “本轮 billableHours / (本轮 billableHours)” => 1（即存单视为本轮结算全量）
     *          （你后续若需要按“整单总时长”拆分，我们在 v0.2 增加 Order 上的 plannedHours 或从商城订单推导）
     * - COMPLETE：若之前已存单结算过，则结算剩余 0；否则 1
     */
    private async computeDispatchRatio(order: any, dispatch: any, mode: 'ARCHIVE' | 'COMPLETE'): Promise<number> {
        const billingMode = order.project.billingMode as BillingMode;

        // 已结算累计（只统计本订单历史 settlements 的 calculatedEarnings / playerPool 很难直接反推 ratio）
        // v0.1：用“已存单累计progress/base”作为累计依据（保底单）
        if (billingMode === BillingMode.GUARANTEED) {
            const base = order.baseAmountWan ?? null;
            if (!base || base <= 0) {
                // 没有保底基数：默认按全量处理
                return mode === 'ARCHIVE' ? 0 : 1;
            }

            if (mode === 'ARCHIVE') {
                const progress = await this.sumDispatchProgressWan(dispatch.id);
                // 允许负数（炸单），但进度绝对值不应超过 base（前端应提示，后端也做保护）
                const capped = this.capProgress(progress, base);
                return capped / base;
            }

            // COMPLETE：结算剩余部分
            const archivedDispatchIds = await this.prisma.orderDispatch.findMany({
                where: { orderId: order.id, status: DispatchStatus.ARCHIVED },
                select: { id: true },
            });

            let archivedProgress = 0;
            for (const d of archivedDispatchIds) {
                archivedProgress += await this.sumDispatchProgressWan(d.id);
            }
            archivedProgress = this.capProgress(archivedProgress, base);

            const archivedRatio = archivedProgress / base;

            // 剩余 = 1 - 已存单累计（允许为 0）
            const remaining = Math.max(0, 1 - archivedRatio);
            return remaining;
        }

        // 小时单
        if (billingMode === BillingMode.HOURLY) {
            // 如果之前某轮已经存单结算（有 settlement），COMPLETE 只结剩余（可能为0）
            const hasAnySettlement = await this.prisma.orderSettlement.findFirst({
                where: { orderId: order.id },
                select: { id: true },
            });

            if (mode === 'ARCHIVE') {
                // v0.1：存单即结算本轮全部（因为本轮小时已是本轮完成度）
                return 1;
            }

            // COMPLETE：
            // 如果已经有过存单结算，默认本轮不再重复结算（0）；否则 1
            return hasAnySettlement ? 0 : 1;
        }

        // 兜底：全量
        return 1;
    }

    private capProgress(progress: number, base: number): number {
        if (progress > base) return base;
        if (progress < -base) return -base;
        return progress;
    }

    private async sumDispatchProgressWan(dispatchId: number): Promise<number> {
        const parts = await this.prisma.orderParticipant.findMany({
            where: { dispatchId },
            select: { progressBaseWan: true },
        });
        return parts.reduce((sum, p) => sum + (p.progressBaseWan ?? 0), 0);
    }

    // -----------------------------
    // 8) 批次结算查询 / 标记打款
    // -----------------------------

    /**
     * 批次结算查询（v0.1）
     * - 返回：总收入（实收款统计）、俱乐部收入、应结款、陪玩收益明细列表
     * - 明细字段：陪玩昵称/结算类型/总接单数/总收益
     */
    async querySettlementBatch(query: QuerySettlementBatchDto) {
        const batchType = query.batchType ?? 'MONTHLY_REGULAR';

        const start = query.periodStart ? new Date(query.periodStart) : this.defaultPeriodStart(batchType);
        const end = query.periodEnd ? new Date(query.periodEnd) : this.defaultPeriodEnd(batchType, start);

        // 1) 找窗口内的 settlements
        const settlements = await this.prisma.orderSettlement.findMany({
            where: {
                settledAt: { gte: start, lt: end },
                settlementType: batchType === 'EXPERIENCE_3DAY' ? 'EXPERIENCE' : 'REGULAR',
            },
            include: {
                user: { select: { id: true, name: true, phone: true } },
                order: { select: { id: true, paidAmount: true, clubEarnings: true } },
            },
        });

        // 2) 汇总统计
        const totalIncome = settlements.reduce((sum, s) => sum + (s.order?.paidAmount ?? 0), 0);
        const clubIncome = settlements.reduce((sum, s) => sum + (s.order?.clubEarnings ?? 0), 0);
        const payableToPlayers = settlements.reduce((sum, s) => sum + (s.finalEarnings ?? 0), 0);

        // 3) 按陪玩聚合明细
        const map = new Map<number, any>();
        for (const s of settlements) {
            const uid = s.userId;
            const cur = map.get(uid) ?? {
                userId: uid,
                name: s.user?.name ?? '',
                phone: s.user?.phone ?? '',
                settlementType: s.settlementType,
                totalOrders: 0,
                totalEarnings: 0,
            };
            cur.totalOrders += 1;
            cur.totalEarnings += s.finalEarnings ?? 0;
            map.set(uid, cur);
        }

        return {
            batchType,
            periodStart: start,
            periodEnd: end,
            summary: {
                totalIncome,
                clubIncome,
                payableToPlayers,
            },
            players: Array.from(map.values()).sort((a, b) => b.totalEarnings - a.totalEarnings),
        };
    }

    private defaultPeriodStart(batchType: string): Date {
        const now = new Date();
        if (batchType === 'EXPERIENCE_3DAY') {
            // v0.1：默认取最近 3 天窗口（自然日的严格切分可在 v0.2 做）
            const d = new Date(now);
            d.setDate(d.getDate() - 3);
            d.setHours(0, 0, 0, 0);
            return d;
        }

        // MONTHLY_REGULAR：默认取上月 1 号
        const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const firstOfLastMonth = new Date(firstOfThisMonth.getFullYear(), firstOfThisMonth.getMonth() - 1, 1);
        return firstOfLastMonth;
    }

    private defaultPeriodEnd(batchType: string, start: Date): Date {
        if (batchType === 'EXPERIENCE_3DAY') {
            const end = new Date(start);
            end.setDate(end.getDate() + 3);
            return end;
        }
        // MONTHLY_REGULAR：start 为上月 1 号，则 end 为本月 1 号
        return new Date(start.getFullYear(), start.getMonth() + 1, 1);
    }

    /**
     * 批量标记打款（按 settlementIds）
     * - 必须记录审计日志（你强要求）
     */
    async markSettlementsPaid(dto: MarkPaidDto, operatorId: number) {
        const now = new Date();

        const settlements = await this.prisma.orderSettlement.findMany({
            where: { id: { in: dto.settlementIds } },
            select: { id: true, orderId: true, userId: true, finalEarnings: true, paymentStatus: true },
        });

        if (settlements.length === 0) throw new NotFoundException('未找到结算记录');

        // 只更新未打款的
        await this.prisma.orderSettlement.updateMany({
            where: { id: { in: dto.settlementIds }, paymentStatus: PaymentStatus.UNPAID },
            data: { paymentStatus: PaymentStatus.PAID, paidAt: now },
        });

        // 审计：写入 user_logs
        // 这里按订单聚合记录更清晰
        const grouped = new Map<number, any[]>();
        for (const s of settlements) {
            grouped.set(s.orderId, [...(grouped.get(s.orderId) ?? []), s]);
        }

        for (const [orderId, list] of grouped) {
            await this.logOrderAction(operatorId, orderId, 'MARK_PAID', {
                settlements: list.map(x => ({ id: x.id, userId: x.userId, amount: x.finalEarnings })),
                remark: dto.remark ?? null,
            });
        }

        return { message: '打款状态更新成功', count: dto.settlementIds.length };
    }

    // -----------------------------
    // 9) 陪玩查询自己的记录
    // -----------------------------

    async listMyParticipations(userId: number) {
        return this.prisma.orderParticipant.findMany({
            where: { userId },
            orderBy: { id: 'desc' },
            include: {
                dispatch: {
                    include: {
                        order: {
                            select: {
                                id: true,
                                autoSerial: true,
                                status: true,
                                paidAmount: true,
                                customerGameId: true,
                                createdAt: true,
                            },
                        },
                    },
                },
            },
        });
    }

    async listMySettlements(userId: number) {
        return this.prisma.orderSettlement.findMany({
            where: { userId },
            orderBy: { settledAt: 'desc' },
            include: {
                order: {
                    select: {
                        id: true,
                        autoSerial: true,
                        paidAmount: true,
                        status: true,
                        customerGameId: true,
                    },
                },
                dispatch: {
                    select: {
                        id: true,
                        round: true,
                        status: true,
                        archivedAt: true,
                        completedAt: true,
                    },
                },
            },
        });
    }

    // -----------------------------
    // 10) 审计日志（UserLog）
    // -----------------------------

    /**
     * 统一写操作日志
     * - 你明确要求必须记录：
     *   1) 评级调整（users 模块已有）
     *   2) 结算分润、打款
     *   3) 单个订单对单个陪玩收益的手动修改（v0.2 会实现 adjust API）
     *
     * 我这里把订单侧关键动作都写入：
     * - CREATE_ORDER / CREATE_DISPATCH / ASSIGN_DISPATCH / ACCEPT_DISPATCH / ARCHIVE_DISPATCH / COMPLETE_DISPATCH
     * - SETTLE_ARCHIVE / SETTLE_COMPLETE / MARK_PAID
     */
    private async logOrderAction(operatorId: number, orderId: number, action: string, newData: any) {
        await this.prisma.userLog.create({
            data: {
                userId: operatorId,
                action,
                targetType: 'ORDER',
                targetId: orderId,
                oldData: null,
                newData,
                remark: null,
            },
        });
    }
}
