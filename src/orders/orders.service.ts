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

    async getOrderDetail(id: number) {
        const order = await this.prisma.order.findUnique({
            where: { id },
            include: {
                project: true,
                dispatcher: { select: { id: true, name: true, phone: true } },

                // ✅ 当前派单批次
                currentDispatch: {
                    include: {
                        participants: {
                            where: { isActive: true }, // ✅ 只取当前有效参与者
                            include: {
                                user: { select: { id: true, name: true, phone: true, workStatus: true } }, // ✅ 关键：把 user 带出来
                            },
                            orderBy: { id: 'asc' },
                        },
                    },
                },

                // ✅ 历史批次（详情页展示派单历史 & 接单明细）
                dispatches: {
                    orderBy: { round: 'desc' },
                    include: {
                        participants: {
                            include: {
                                user: { select: { id: true, name: true, phone: true } },
                            },
                            orderBy: { id: 'asc' },
                        },
                    },
                },

                // ✅ 结算明细（可选：如果你详情页要展示）
                settlements: {
                    include: {
                        user: { select: { id: true, name: true, phone: true } },
                    },
                    orderBy: { id: 'desc' },
                },
            },
        });

        if (!order) {
            throw new NotFoundException('订单不存在');
        }

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

    async acceptDispatch(
        dispatchId: number,
        userId: number,
        dto: AcceptDispatchDto,
        payload?: string | { remark?: string },
    ) {
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

        await this.prisma.user.update({
            where: { id: userId },
            data: { workStatus: 'WORKING' as any },
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

        const remark = typeof payload === 'string' ? payload : payload?.remark;

        await this.logOrderAction(userId, refreshed.orderId, 'ACCEPT_DISPATCH', {
            dispatchId,
            remark: remark ?? null,
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
        // ✅ A：并发抢占（原子条件判断）
        // 只有 status=ACCEPTED 的批次允许进入存单；若并发已被处理，count=0 直接拒绝
        const locked = await this.prisma.orderDispatch.updateMany({
            where: { id: dispatchId, status: DispatchStatus.ACCEPTED },
            data: { status: DispatchStatus.ACCEPTED }, // 不改变，只用于原子判断
        });
        if (locked.count === 0) {
            throw new ForbiddenException('该派单批次已被处理或状态已变化，请刷新后重试');
        }
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

        // ✅ 3.1 本轮参与者结束：全部置为 isActive=false（存单后允许再派，但本轮参与者成为历史）
        await this.prisma.orderParticipant.updateMany({
            where: { dispatchId },
            data: { isActive: false },
        });

        // 4) 更新订单状态为 ARCHIVED（允许再次派单；但不回到未派单，不清空 currentDispatchId）
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

        // 6) 对应打手改变状态，可再次接单
        const userIds = dispatch.participants.map((p) => p.userId);
        await this.prisma.user.updateMany({
            where: { id: { in: userIds } },
            data: { workStatus: 'IDLE' as any },
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
        // ✅ A：并发抢占（原子条件判断）
        const locked = await this.prisma.orderDispatch.updateMany({
            where: { id: dispatchId, status: DispatchStatus.ACCEPTED },
            data: { status: DispatchStatus.ACCEPTED },
        });
        if (locked.count === 0) {
            throw new ForbiddenException('该派单批次已被处理或状态已变化，请刷新后重试');
        }

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

        // ✅ 保底单结单兜底：若未传 progresses，则默认用“剩余保底”作为本轮进度，均分写入 participants
        const billingMode = dispatch.order.project.billingMode;

        if (billingMode === BillingMode.GUARANTEED) {
            const hasProgresses = Array.isArray((dto as any)?.progresses) && (dto as any).progresses.length > 0;

            if (!hasProgresses) {
                const base = Number(dispatch.order.baseAmountWan ?? 0);

                if (Number.isFinite(base) && base > 0) {
                    // 已存单累计进度（仅 ARCHIVED 轮次）
                    const archived = await this.prisma.orderDispatch.findMany({
                        where: { orderId: dispatch.orderId, status: DispatchStatus.ARCHIVED },
                        select: { id: true },
                    });

                    let archivedProgress = 0;
                    for (const d of archived) {
                        archivedProgress += await this.sumDispatchProgressWan(d.id);
                    }
                    archivedProgress = this.capProgress(archivedProgress, base);

                    const remaining = Math.max(0, base - archivedProgress);

                    const parts = dispatch.participants || [];
                    const each = parts.length > 0 ? remaining / parts.length : remaining;

                    // 直接写入本轮 participants.progressBaseWan（允许 0）
                    for (const p of parts) {
                        await this.prisma.orderParticipant.update({
                            where: { id: p.id },
                            data: { progressBaseWan: each },
                        });
                    }

                    // 同时把 dto.progresses 补上，保证后续日志/结算计算一致
                    (dto as any).progresses = parts.map((p) => ({
                        userId: p.userId,
                        progressBaseWan: each,
                    }));
                }
            }
        }

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

        // ✅ 3.1 本轮参与者结束：全部置为 isActive=false（结单后本轮参与者成为历史）
        await this.prisma.orderParticipant.updateMany({
            where: { dispatchId },
            data: { isActive: false },
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

        // 6) 对应打手改变状态，可再次接单
        const userIds = dispatch.participants.map((p) => p.userId);
        await this.prisma.user.updateMany({
            where: { id: { in: userIds } },
            data: { workStatus: 'IDLE' as any },
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
    private async computeAndPersistBillingHours(dispatchId: number, action: 'ARCHIVE' | 'COMPLETE', deductMinutesOption?: string) {
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

        const endTime = action === 'ARCHIVE' ? new Date() : new Date();

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
            case 'M10':
                return 10;
            case 'M20':
                return 20;
            case 'M30':
                return 30;
            case 'M40':
                return 40;
            case 'M50':
                return 50;
            case 'M60':
                return 60;
            default:
                return 0;
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

    // private async createSettlementsForDispatch(params: { orderId: number; dispatchId: number; mode: 'ARCHIVE' | 'COMPLETE' }) {
    //     const { orderId, dispatchId, mode } = params;
    //
    //     const order = await this.prisma.order.findUnique({
    //         where: { id: orderId },
    //         include: {
    //             project: true,
    //             dispatches: {
    //                 include: {
    //                     participants: true,
    //                 },
    //             },
    //         },
    //     });
    //     if (!order) throw new NotFoundException('订单不存在');
    //
    //     const dispatch = await this.prisma.orderDispatch.findUnique({
    //         where: { id: dispatchId },
    //         include: {
    //             participants: true,
    //         },
    //     });
    //     if (!dispatch) throw new NotFoundException('派单批次不存在');
    //
    //     // 参与者（v0.1：默认 1~2 人）
    //     const participants = dispatch.participants;
    //     if (!participants || participants.length === 0) throw new BadRequestException('派单批次没有参与者，无法结算');
    //
    //     // 订单级分摊：俱乐部/客服/推广
    //     const clubRate = order.customClubRate ?? order.clubRate ?? null; // clubRate 已在创建时落库
    //     const csRate = order.csRate ?? 0;
    //     const inviteRate = order.inviteRate ?? 0;
    //
    //     const clubEarnings = clubRate ? order.paidAmount * clubRate : 0;
    //     const csEarningsTotal = csRate ? order.paidAmount * csRate : 0;
    //     const inviteEarningsTotal = order.inviter && inviteRate ? order.paidAmount * inviteRate : 0;
    //
    //     const playerPool = order.paidAmount - clubEarnings - csEarningsTotal - inviteEarningsTotal;
    //
    //     // 结算类型：体验/福袋 = EXPERIENCE，否则 REGULAR（用于批次结算页面）
    //     const settlementType =
    //         order.project.type === 'EXPERIENCE' || order.project.type === 'LUCKY_BAG' ? 'EXPERIENCE' : 'REGULAR';
    //
    //     // 计算本轮应该结算的比例 ratio
    //     const ratio = await this.computeDispatchRatio(order, dispatch, mode);
    //
    //     // 本轮陪玩总收益
    //     const dispatchPlayerTotal = playerPool * ratio;
    //
    //     // v0.1：均分
    //     const each = participants.length > 0 ? dispatchPlayerTotal / participants.length : 0;
    //
    //     // 写入 settlement（一人一条）
    //     // 为避免重复生成：如果这个 dispatch 已经有 settlement，就直接拒绝（幂等保护）
    //     const existing = await this.prisma.orderSettlement.findFirst({
    //         where: { orderId, dispatchId },
    //         select: { id: true },
    //     });
    //     if (existing) {
    //         throw new BadRequestException('该派单批次已生成结算记录，禁止重复结算');
    //     }
    //
    //     await this.prisma.$transaction(async (tx) => {
    //         for (const p of participants) {
    //             await tx.orderSettlement.create({
    //                 data: {
    //                     orderId,
    //                     dispatchId,
    //                     userId: p.userId,
    //                     settlementType,
    //                     calculatedEarnings: each,
    //                     manualAdjustment: 0,
    //                     finalEarnings: each,
    //                     clubEarnings: clubEarnings ? clubEarnings * ratio : null,
    //                     csEarnings: csEarningsTotal ? csEarningsTotal * ratio : null,
    //                     inviteEarnings: inviteEarningsTotal ? inviteEarningsTotal * ratio : null,
    //                     paymentStatus: PaymentStatus.UNPAID,
    //                 },
    //             });
    //         }
    //
    //         // 同时把 order 上的汇总字段落一下（便于对账）
    //         await tx.order.update({
    //             where: { id: orderId },
    //             data: {
    //                 clubEarnings,
    //                 clubRate: clubRate ?? null,
    //                 totalPlayerEarnings: playerPool,
    //             },
    //         });
    //     });
    //
    //     // 审计日志（必须记录）
    //     await this.logOrderAction(order.dispatcherId, orderId, mode === 'ARCHIVE' ? 'SETTLE_ARCHIVE' : 'SETTLE_COMPLETE', {
    //         dispatchId,
    //         ratio,
    //         playerPool,
    //         dispatchPlayerTotal,
    //         each,
    //     });
    //
    //     return true;
    // }

    /**
     * 生成结算明细（核心）
     *
     * 结算口径（按你最新规则）：
     * - 单次派单 + 本次为结单：直接按订单实付金额 paidAmount 结算全量
     * - 多次派单：使用 computeDispatchRatio（保底进度/结单结剩余等）计算本轮 ratio
     * - 分配方式：优先按 participant.contributionAmount 权重；否则均分
     * - 到手收益 multiplier 优先级：
     *   1) 订单固定抽成（平台抽成）：each * (1 - 抽成)
     *   2) 项目固定抽成（平台抽成）：each * (1 - 抽成)
     *   3) 陪玩分红比例（到手比例）：each * 分红
     */
    private async createSettlementsForDispatch(params: { orderId: number; dispatchId: number; mode: 'ARCHIVE' | 'COMPLETE' }) {
        const { orderId, dispatchId, mode } = params;

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                project: true,
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

        const participants = dispatch.participants || [];
        if (participants.length === 0) throw new BadRequestException('派单批次没有参与者，无法结算');

        // 幂等保护：同一 dispatch 只能生成一次 settlement
        const existing = await this.prisma.orderSettlement.findFirst({
            where: { orderId, dispatchId },
            select: { id: true },
        });
        if (existing) throw new BadRequestException('该派单批次已生成结算记录，禁止重复结算');

        // 结算类型：体验/福袋 = EXPERIENCE，否则 REGULAR
        const settlementType = (order.project.type === 'EXPERIENCE' || order.project.type === 'LUCKY_BAG')
            ? 'EXPERIENCE'
            : 'REGULAR';

        // ---------- 1) 计算 ratio ----------
        const dispatchCount = await this.prisma.orderDispatch.count({ where: { orderId } });

        let ratio: number;
        if (dispatchCount === 1 && mode === 'COMPLETE') {
            // ✅ 规则 1：单次派单 + 本次结单 = 全量结算
            ratio = 1;
        } else {
            // ✅ 规则 2：多次派单仍用你现有 ratio 逻辑（保底进度/结剩余等）
            ratio = await this.computeDispatchRatio(order, dispatch, mode);
        }

        // ---------- 2) 计算本轮“可分配金额” ----------
        // ✅ 按你要求：直接基于订单实付金额 paidAmount（不再额外扣 cs/invite 等）
        const totalForThisDispatch = (order.paidAmount ?? 0) * ratio;

        // ---------- 3) 本轮内按贡献/均分拆给每个参与者 ----------
        const weights = participants.map((p) => {
            const w = Number(p.contributionAmount ?? 0);
            return Number.isFinite(w) && w > 0 ? w : 0;
        });
        const weightSum = weights.reduce((a, b) => a + b, 0);

        const baseEachList = participants.map((_, idx) => {
            if (weightSum > 0) return totalForThisDispatch * (weights[idx] / weightSum);
            return totalForThisDispatch / participants.length;
        });

        // ---------- 4) 计算到手 multiplier（优先级：订单抽成 > 项目抽成 > 陪玩分红） ----------
        const normalizeToRatio = (v: any, fallback: number) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            return n > 1 ? n / 100 : n; // 兼容 10 / 0.1 / 60 / 0.6
        };

        const orderCutRaw = order.customClubRate ?? null; // 订单固定抽成（平台抽成）
        // 项目固定抽成优先取快照，避免项目后改影响历史
        const snap: any = order.projectSnapshot || {};
        const projectCutRaw = snap.clubRate ?? order.project?.clubRate ?? null;

        // 陪玩分红比例来自 staffRating.rate（例如 60 表示 60%）
        const userIds = participants.map((p) => p.userId);
        const users = await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, staffRating: { select: { rate: true } } },
        });
        const shareMap = new Map<number, number>();
        for (const u of users) {
            shareMap.set(u.id, normalizeToRatio(u.staffRating?.rate, 1)); // 默认 100%
        }

        const hasOrderCut = orderCutRaw != null && !!orderCutRaw;

        const hasProjectCut = !hasOrderCut && projectCutRaw != null && !!projectCutRaw;

        const orderCut = hasOrderCut ? normalizeToRatio(orderCutRaw, 0) : 0;
        const projectCut = hasProjectCut ? normalizeToRatio(projectCutRaw, 0) : 0;

        await this.prisma.$transaction(async (tx) => {
            for (let i = 0; i < participants.length; i++) {
                const p = participants[i];
                const calculated = baseEachList[i];

                // ✅ multiplier 按优先级
                let multiplier = 1;

                if (hasOrderCut) {
                    multiplier = Math.max(0, 1 - orderCut);
                } else if (hasProjectCut) {
                    multiplier = Math.max(0, 1 - projectCut);
                } else {
                    multiplier = Math.max(0, shareMap.get(p.userId) ?? 1);
                }

                const final = Math.trunc(calculated * multiplier);

                await tx.orderSettlement.create({
                    data: {
                        orderId,
                        dispatchId,
                        userId: p.userId,
                        settlementType,

                        // calculatedEarnings：本轮分到的“基础收益”（均分/按贡献后）
                        calculatedEarnings: calculated,

                        // manualAdjustment：用于奖惩/纠错（后面会手工改 final）
                        manualAdjustment: final - calculated,

                        // finalEarnings：本轮实际到手
                        finalEarnings: final,

                        // clubEarnings：这里记录“差额”（平台抽成/未分配部分），用于对账展示
                        clubEarnings: calculated - final,

                        // 这两项暂不再按新口径扣（不影响你后续财务流程）
                        csEarnings: null,
                        inviteEarnings: null,

                        paymentStatus: PaymentStatus.UNPAID,
                    },
                });
            }

            // 汇总回写：用 settlements 聚合避免多轮不一致
            const agg = await tx.orderSettlement.aggregate({
                where: { orderId },
                _sum: { finalEarnings: true, clubEarnings: true },
            });

            await tx.order.update({
                where: { id: orderId },
                data: {
                    totalPlayerEarnings: Number(agg._sum.finalEarnings ?? 0),
                    clubEarnings: Number(agg._sum.clubEarnings ?? 0),
                },
            });
        });

        await this.logOrderAction(order.dispatcherId, orderId, mode === 'ARCHIVE' ? 'SETTLE_ARCHIVE' : 'SETTLE_COMPLETE', {
            dispatchId,
            ratio,
            dispatchCount,
            totalForThisDispatch,
            rule: dispatchCount === 1 && mode === 'COMPLETE' ? 'SINGLE_COMPLETE_FULL' : 'RATIO_BY_PROGRESS',
            multiplierPriority: hasOrderCut ? 'ORDER_CUT' : hasProjectCut ? 'PROJECT_CUT' : 'PLAYER_SHARE',
        });

        return true;
    }



    private async computeDispatchRatio(order: any, dispatch: any, mode: 'ARCHIVE' | 'COMPLETE'): Promise<number> {
        const billingMode = order.project.billingMode as BillingMode;

        if (billingMode === BillingMode.GUARANTEED) {
            const base = order.baseAmountWan ?? null;
            if (!base || base <= 0) {
                // 没有保底基数：默认按全量处理
                return mode === 'ARCHIVE' ? 0 : 1;
            }

            if (mode === 'ARCHIVE') {
                const progress = await this.sumDispatchProgressWan(dispatch.id);
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

            const remaining = Math.max(0, 1 - archivedRatio);
            return remaining;
        }

        if (billingMode === BillingMode.HOURLY) {
            const hasAnySettlement = await this.prisma.orderSettlement.findFirst({
                where: { orderId: order.id },
                select: { id: true },
            });

            if (mode === 'ARCHIVE') {
                return 1;
            }

            return hasAnySettlement ? 0 : 1;
        }

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

    async querySettlementBatch(query: QuerySettlementBatchDto) {
        const batchType = query.batchType ?? 'MONTHLY_REGULAR';

        const start = query.periodStart ? new Date(query.periodStart) : this.defaultPeriodStart(batchType);
        const end = query.periodEnd ? new Date(query.periodEnd) : this.defaultPeriodEnd(batchType, start);

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

        const totalIncome = settlements.reduce((sum, s) => sum + (s.order?.paidAmount ?? 0), 0);
        const clubIncome = settlements.reduce((sum, s) => sum + (s.order?.clubEarnings ?? 0), 0);
        const payableToPlayers = settlements.reduce((sum, s) => sum + (s.finalEarnings ?? 0), 0);

        const map = new Map<number, any>();
        for (const s of settlements) {
            const uid = s.userId;
            const cur =
                map.get(uid) ?? ({
                    userId: uid,
                    name: s.user?.name ?? '',
                    phone: s.user?.phone ?? '',
                    settlementType: s.settlementType,
                    totalOrders: 0,
                    totalEarnings: 0,
                } as any);
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
            const d = new Date(now);
            d.setDate(d.getDate() - 3);
            d.setHours(0, 0, 0, 0);
            return d;
        }

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
        return new Date(start.getFullYear(), start.getMonth() + 1, 1);
    }

    async markSettlementsPaid(dto: MarkPaidDto, operatorId: number) {
        const now = new Date();

        const settlements = await this.prisma.orderSettlement.findMany({
            where: { id: { in: dto.settlementIds } },
            select: { id: true, orderId: true, userId: true, finalEarnings: true, paymentStatus: true },
        });

        if (settlements.length === 0) throw new NotFoundException('未找到结算记录');

        await this.prisma.orderSettlement.updateMany({
            where: { id: { in: dto.settlementIds }, paymentStatus: PaymentStatus.UNPAID },
            data: { paymentStatus: PaymentStatus.PAID, paidAt: now },
        });

        const grouped = new Map<number, any[]>();
        for (const s of settlements) {
            grouped.set(s.orderId, [...(grouped.get(s.orderId) ?? []), s]);
        }

        for (const [orderId, list] of grouped) {
            await this.logOrderAction(operatorId, orderId, 'MARK_PAID', {
                settlements: list.map((x) => ({ id: x.id, userId: x.userId, amount: x.finalEarnings })),
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

    private async logOrderAction(operatorId: number, orderId: number, action: string, newData: any) {
        const uid = Number(operatorId);
        if (!uid) {
            // 这里建议抛错，能尽快暴露“接口未鉴权/未注入用户”问题
            throw new ForbiddenException('缺少操作人身份（operatorId），请重新登录后重试');
            // 如果你不想影响业务主流程，也可以改成：return;
        }
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

    //取消订单
    async cancelOrder(orderId: number, operatorId: number, remark?: string) {
        if (!orderId) throw new BadRequestException('orderId 必填');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            select: { id: true, status: true },
        });

        if (!order) throw new NotFoundException('订单不存在');

        const forbidden = new Set(['COMPLETED', 'REFUNDED']);
        if (forbidden.has(String(order.status))) {
            throw new ForbiddenException('当前订单状态不可取消');
        }

        const updated = await this.prisma.order.update({
            where: { id: orderId },
            data: {
                status: 'CANCELLED' as any,
            },
        });

        if (operatorId) {
            await this.prisma.userLog.create({
                data: {
                    userId: operatorId,
                    action: 'CANCEL_ORDER',
                    targetType: 'ORDER',
                    targetId: orderId,
                    oldData: { status: order.status } as any,
                    newData: { status: 'CANCELLED' } as any,
                    remark: remark || '取消订单',
                },
            });
        }

        return updated;
    }

    // ✅ 派单 / 重新派单（创建新的派单批次）
    // ✅ ARCHIVED 状态也允许再次派单；派单后状态流转与新建订单一致（WAIT_ACCEPT）
    async assignDispatch(orderId: number, playerIds: number[], operatorId: number, remark?: string) {
        if (!orderId) throw new BadRequestException('orderId 必填');
        if (!Array.isArray(playerIds)) throw new BadRequestException('playerIds 必须为数组');
        if (playerIds.length < 1 || playerIds.length > 2) throw new BadRequestException('playerIds 必须为 1~2 个');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { dispatches: { select: { id: true, round: true, status: true } } },
        });

        if (!order) throw new NotFoundException('订单不存在');

        // ✅ v0.1：允许 WAIT_ASSIGN / ARCHIVED 派单
        // - ARCHIVED：存单后仍保持存单态，但允许创建新 dispatch（round+1），并把 currentDispatch 指向新批次
        const allowOrderStatus = new Set(['WAIT_ASSIGN', 'ARCHIVED']);
        if (!allowOrderStatus.has(String(order.status))) {
            throw new ForbiddenException('当前订单状态不可派单');
        }

        // round 从 1 开始递增
        const nextRound = (order.dispatches?.reduce((max, d) => Math.max(max, d.round), 0) || 0) + 1;

        // 创建本轮派单
        const dispatch = await this.prisma.orderDispatch.create({
            data: {
                orderId,
                round: nextRound,
                status: 'WAIT_ACCEPT' as any,
                assignedAt: new Date(),
                remark: remark || null,
            },
        });

        // 创建参与者
        await this.prisma.orderParticipant.createMany({
            data: playerIds.map((userId) => ({
                dispatchId: dispatch.id,
                userId,
                isActive: true,
            })),
        });

        // 更新订单状态 + currentDispatch 指针（状态流转与新建订单一致）
        await this.prisma.order.update({
            where: { id: orderId },
            data: {
                status: 'WAIT_ACCEPT' as any,
                currentDispatchId: dispatch.id,
            },
        });

        // 记录日志
        if (operatorId) {
            await this.prisma.userLog.create({
                data: {
                    userId: operatorId,
                    action: 'ASSIGN_DISPATCH',
                    targetType: 'ORDER',
                    targetId: orderId,
                    oldData: { status: order.status } as any,
                    newData: { status: 'WAIT_ACCEPT', playerIds, round: nextRound } as any,
                    remark: remark || `派单 round=${nextRound}`,
                },
            });
        }

        return this.getOrderDetail(orderId);
    }

    // ✅ 我的接单记录（陪玩端/员工端查看自己参与的派单批次）
    async listMyDispatches(params: { userId: number; page: number; limit: number; status?: string }) {
        const userId = Number(params.userId);
        const page = Math.max(1, Number(params.page ?? 1));
        const limit = Math.min(100, Math.max(1, Number(params.limit ?? 20)));
        const skip = (page - 1) * limit;

        if (!userId) throw new BadRequestException('userId 缺失');

        const where: any = {
            participants: { some: { userId } },
        };
        if (params.status) where.status = params.status as any;

        const [data, total] = await Promise.all([
            this.prisma.orderDispatch.findMany({
                where,
                skip,
                take: limit,
                orderBy: { id: 'desc' },
                include: {
                    order: {
                        include: {
                            project: true,
                            dispatcher: { select: { id: true, name: true, phone: true } },
                        },
                    },
                    participants: {
                        include: {
                            user: { select: { id: true, name: true, phone: true } },
                        },
                    },
                },
            }),
            this.prisma.orderDispatch.count({ where }),
        ]);

        return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
    }

    async updatePaidAmount(orderId: number, paidAmount: number, operatorId: number, remark?: string) {
        if (!orderId) throw new BadRequestException('id 必填');
        if (!Number.isFinite(paidAmount) || paidAmount < 0) throw new BadRequestException('paidAmount 非法');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { project: true },
        });
        if (!order) throw new NotFoundException('订单不存在');

        const snapshot: any = order.projectSnapshot || {};
        const billingMode = snapshot.billingMode || (order.project as any)?.billingMode;

        if (billingMode !== 'HOURLY') {
            throw new ForbiddenException('仅小时单允许修改实付金额');
        }

        if (paidAmount < order.paidAmount) {
            throw new ForbiddenException('实付金额仅允许增加（超时补收），不允许减少');
        }

        const old = order.paidAmount;
        const updated = await this.prisma.order.update({
            where: { id: orderId },
            data: { paidAmount },
        });

        if (operatorId) {
            await this.prisma.userLog.create({
                data: {
                    userId: operatorId,
                    action: 'UPDATE_PAID_AMOUNT',
                    targetType: 'ORDER',
                    targetId: orderId,
                    oldData: { paidAmount: old } as any,
                    newData: { paidAmount } as any,
                    remark: remark || `小时单补收：${old} → ${paidAmount}`,
                },
            });
        }

        return updated;
    }

    async updateDispatchParticipants(dispatchId: number, playerIds: number[], operatorId: number, remark?: string) {
        if (!dispatchId) throw new BadRequestException('dispatchId 必填');
        if (!Array.isArray(playerIds) || playerIds.length < 1 || playerIds.length > 2) {
            throw new BadRequestException('playerIds 必须为 1~2 个');
        }

        const dispatch = await this.prisma.orderDispatch.findUnique({
            where: { id: dispatchId },
            include: {
                order: true,
                participants: true,
            },
        });
        if (!dispatch) throw new NotFoundException('派单批次不存在');

        // ✅ 只允许待接单阶段修改参与者
        const allow = new Set(['WAIT_ACCEPT', 'WAIT_ASSIGN']);
        if (!allow.has(String(dispatch.status))) {
            throw new ForbiddenException('当前派单状态不可修改参与者');
        }

        // ✅ 若已有任一参与者 acceptedAt 非空，则不允许修改
        if (dispatch.participants.some((p) => !!p.acceptedAt)) {
            throw new ForbiddenException('已有打手接单，不能修改参与者（请存单后重新派单）');
        }

        // 旧记录全部置无效
        await this.prisma.orderParticipant.updateMany({
            where: { dispatchId },
            data: { isActive: false },
        });

        // 创建新参与者（isActive=true）
        await this.prisma.orderParticipant.createMany({
            data: playerIds.map((userId) => ({
                dispatchId,
                userId,
                isActive: true,
            })),
        });

        // 写日志
        if (operatorId) {
            await this.prisma.userLog.create({
                data: {
                    userId: operatorId,
                    action: 'UPDATE_DISPATCH_PARTICIPANTS',
                    targetType: 'ORDER_DISPATCH',
                    targetId: dispatchId,
                    oldData: { playerIds: dispatch.participants.map((p) => p.userId) } as any,
                    newData: { playerIds } as any,
                    remark: remark || '更新派单参与者',
                },
            });
        }

        return this.getOrderDetail(dispatch.orderId);
    }

    async adjustSettlementFinalEarnings(dto: { settlementId: number; finalEarnings: number; remark?: string }, operatorId: number) {
        const settlementId = Number(dto.settlementId);
        const finalEarnings = Number(dto.finalEarnings);

        if (!settlementId) throw new BadRequestException('settlementId 必填');
        if (!Number.isFinite(finalEarnings)) throw new BadRequestException('finalEarnings 非法');

        const s = await this.prisma.orderSettlement.findUnique({
            where: { id: settlementId },
            select: { id: true, orderId: true, calculatedEarnings: true, finalEarnings: true, manualAdjustment: true },
        });
        if (!s) throw new NotFoundException('结算记录不存在');

        const manualAdjustment = finalEarnings - Number(s.calculatedEarnings ?? 0);

        const updated = await this.prisma.orderSettlement.update({
            where: { id: settlementId },
            data: {
                finalEarnings,
                manualAdjustment,
            },
        });

        // ✅ 记录日志（你要求关键动作必须记录）
        await this.logOrderAction(operatorId, s.orderId, 'ADJUST_SETTLEMENT', {
            settlementId,
            oldFinalEarnings: s.finalEarnings,
            newFinalEarnings: finalEarnings,
            manualAdjustment,
            remark: dto.remark ?? null,
        });

        return updated;
    }

    //退款功能
    async refundOrder(orderId: number, operatorId: number, remark?: string) {
        orderId = Number(orderId);
        operatorId = Number(operatorId);
        if (!orderId) throw new BadRequestException('orderId 必填');
        if (!operatorId) throw new ForbiddenException('未登录或无权限操作');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: {
                dispatches: { select: { id: true, status: true } },
                settlements: { select: { id: true, paymentStatus: true, calculatedEarnings: true, finalEarnings: true } },
            },
        });
        if (!order) throw new NotFoundException('订单不存在');

        // 已退款幂等
        if (order.status === OrderStatus.REFUNDED) return this.getOrderDetail(orderId);

        // 若已打款，不允许退款清零（避免财务对不上）
        const hasPaid = order.settlements?.some((s) => s.paymentStatus === PaymentStatus.PAID);
        if (hasPaid) throw new ForbiddenException('存在已打款结算记录，禁止退款（请先走财务冲正流程）');

        const now = new Date();

        await this.prisma.$transaction(async (tx) => {
            // 1) 订单状态置 REFUNDED（你要“结单状态并标记退款”：这里用 REFUNDED 即“已结单且已退款”）
            await tx.order.update({
                where: { id: orderId },
                data: { status: OrderStatus.REFUNDED },
            });

            // 2) 当前/历史 dispatch 如果不是终态，可选标记为 COMPLETED（防止继续流转）
            //    这里按“退款即结束”处理：把非 COMPLETED 的 ACCEPTED/WAIT_ACCEPT/WAIT_ASSIGN/ARCHIVED 统一改为 COMPLETED
            await tx.orderDispatch.updateMany({
                where: {
                    orderId,
                    status: { in: [DispatchStatus.WAIT_ASSIGN, DispatchStatus.WAIT_ACCEPT, DispatchStatus.ACCEPTED, DispatchStatus.ARCHIVED] },
                },
                data: {
                    status: DispatchStatus.COMPLETED,
                    completedAt: now,
                    remark: remark ? `REFUND:${remark}` : 'REFUND',
                },
            });

            // 3) 若已经结单产生 settlements：清零陪玩收益（finalEarnings=0，manualAdjustment = -calculatedEarnings）
            //    这样“清零”且保留 calculatedEarnings 便于追溯
            if (order.settlements && order.settlements.length > 0) {
                for (const s of order.settlements) {
                    await tx.orderSettlement.update({
                        where: { id: s.id },
                        data: {
                            finalEarnings: 0,
                            manualAdjustment: 0 - Number(s.calculatedEarnings ?? 0),
                            adjustedBy: operatorId,
                            adjustedAt: now,
                            adjustRemark: remark ? `REFUND_CLEAR:${remark}` : 'REFUND_CLEAR',
                        },
                    });
                }

                // 同步汇总
                await tx.order.update({
                    where: { id: orderId },
                    data: {
                        totalPlayerEarnings: 0,
                    },
                });
            }
        });

        await this.logOrderAction(operatorId, orderId, 'REFUND_ORDER', {
            remark: remark ?? null,
            clearedSettlements: (order.settlements?.length ?? 0) > 0,
            clearedCount: order.settlements?.length ?? 0,
        });

        return this.getOrderDetail(orderId);
    }

    //订单编辑
    async updateOrderEditable(dto: any, operatorId: number) {
        operatorId = Number(operatorId);
        const orderId = Number(dto?.id);
        if (!orderId) throw new BadRequestException('id 必填');
        if (!operatorId) throw new ForbiddenException('未登录或无权限操作');

        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { project: true },
        });
        if (!order) throw new NotFoundException('订单不存在');

        // 未结单才允许编辑
        const forbid = new Set<OrderStatus>([OrderStatus.COMPLETED, OrderStatus.REFUNDED]);
        if (forbid.has(order.status)) throw new ForbiddenException('已结单/已退款订单不允许编辑');

        // 允许编辑的字段（不含陪玩/派单）
        const data: any = {
            receivableAmount: dto.receivableAmount != null ? Number(dto.receivableAmount) : undefined,
            paidAmount: dto.paidAmount != null ? Number(dto.paidAmount) : undefined,
            baseAmountWan: dto.baseAmountWan != null ? Number(dto.baseAmountWan) : undefined,
            customerGameId: dto.customerGameId ?? undefined,
            orderTime: dto.orderTime ? new Date(dto.orderTime) : undefined,
            paymentTime: dto.paymentTime ? new Date(dto.paymentTime) : undefined,
            csRate: dto.csRate != null ? Number(dto.csRate) : undefined,
            inviteRate: dto.inviteRate != null ? Number(dto.inviteRate) : undefined,
            inviter: dto.inviter ?? undefined,
            customClubRate: dto.customClubRate != null ? Number(dto.customClubRate) : undefined,
        };

        // 项目变更：同步 projectSnapshot + clubRate（落库快照）
        if (dto.projectId && Number(dto.projectId) !== order.projectId) {
            const project = await this.prisma.gameProject.findUnique({ where: { id: Number(dto.projectId) } });
            if (!project) throw new NotFoundException('项目不存在');

            data.projectId = project.id;

            data.projectSnapshot = {
                id: project.id,
                name: project.name,
                type: project.type,
                billingMode: project.billingMode,
                price: project.price,
                baseAmount: project.baseAmount ?? null,
                clubRate: project.clubRate ?? null,
                coverImage: project.coverImage ?? null,
            } as any;

            // 注意：clubRate 是“订单级固定抽成快照”，仍遵循优先级：customClubRate > 项目 clubRate
            data.clubRate = (dto.customClubRate != null ? Number(dto.customClubRate) : (project.clubRate ?? null));
        }

        const updated = await this.prisma.order.update({
            where: { id: orderId },
            data,
        });

        await this.logOrderAction(operatorId, orderId, 'UPDATE_ORDER', {
            changes: data,
            remark: dto.remark ?? null,
        });

        return this.getOrderDetail(orderId);
    }


}
