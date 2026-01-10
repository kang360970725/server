import {BadRequestException, ForbiddenException, Injectable, NotFoundException} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';
import {CreateOrderDto} from './dto/create-order.dto';
import {QueryOrdersDto} from './dto/query-orders.dto';
import {AssignDispatchDto} from './dto/assign-dispatch.dto';
import {AcceptDispatchDto} from './dto/accept-dispatch.dto';
import {ArchiveDispatchDto} from './dto/archive-dispatch.dto';
import {CompleteDispatchDto} from './dto/complete-dispatch.dto';
import {QuerySettlementBatchDto} from './dto/query-settlement-batch.dto';
import {MarkPaidDto} from './dto/mark-paid.dto';
import {OrderType, BillingMode, DispatchStatus, OrderStatus, PaymentStatus, PlayerWorkStatus} from '@prisma/client';
import {WalletService} from '../wallet/wallet.service';
import { randomUUID } from 'crypto';

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
    constructor(
        private prisma: PrismaService,
        private wallet: WalletService,
    ) {
    }

    // -----------------------------
    // 1) 创建订单
    // -----------------------------

    async createOrder(dto: CreateOrderDto, dispatcherId: number) {
        const project = await this.prisma.gameProject.findUnique({where: {id: dto.projectId}});
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

        // ✅ 赠送单：不收款，但仍然要正常结算/分红
        // - 为避免前端误传金额导致“赠送单被计入营收”，后端这里强制清零
        const isGifted = Boolean(dto.isGifted);

        // 赠送金额口径（最小改动方案）：
        // - 赠送单 giftedAmount = paidAmount（等同“这单价值由平台承担”）
        // - 非赠送单 giftedAmount = 0（或 null）
        const giftedAmount = isGifted ? Number(dto.paidAmount ?? 0) : 0;

        const order = await this.prisma.order.create({
            data: {
                orderQuantity: Number(dto.orderQuantity ?? 1),
                autoSerial: serial,
                // receivableAmount: dto.receivableAmount,
                // paidAmount: dto.paidAmount,
                // paymentTime: dto.paymentTime ? new Date(dto.paymentTime) : null,

                // ✅ 赠送单强制清零金额
                receivableAmount: isGifted ? 0 : dto.receivableAmount,
                paidAmount: isGifted ? 0 : dto.paidAmount,

                // ✅ 赠送单一般不应有付款时间（你也可以按业务改成 now）
                paymentTime: isGifted ? null : (dto.paymentTime ? new Date(dto.paymentTime) : null),

                orderTime: dto.orderTime ? new Date(dto.orderTime) : null,
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

                // ✅ 落库赠送标识
                isGifted,
                giftedAmount,
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

        // ✅ 新建即派单：若传了 playerIds，则直接创建首轮派单并指派
        const playerIds = Array.isArray((dto as any)?.playerIds)
            ? (dto as any).playerIds.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
            : [];

        if (playerIds.length > 0) {
            // 复用你现有派单逻辑（包含防重复、参与者写入、日志等）
            await this.assignDispatch(order.id, playerIds, dispatcherId, 'AUTO_CREATE');
            // 派单后返回完整详情（带 currentDispatch/participants）
            return this.getOrderDetail(order.id);
        }

        // 未选择打手：保持 WAIT_ASSIGN
        return this.getOrderDetail(order.id);
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
            where: {autoSerial: {startsWith: prefix}},
            orderBy: {autoSerial: 'desc'},
            select: {autoSerial: true},
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
            where.autoSerial = {contains: query.serial};
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
            where.customerGameId = {contains: query.customerGameId};
        }

        // 陪玩筛选：通过当前/历史 participant 反查订单
        if (query.playerId) {
            where.dispatches = {
                some: {
                    participants: {
                        some: {userId: query.playerId},
                    },
                },
            };
        }

        const [data, total] = await Promise.all([
            this.prisma.order.findMany({
                where,
                skip,
                take: limit,
                orderBy: {createdAt: 'desc'},
                include: {
                    project: true,
                    dispatcher: {select: {id: true, name: true, phone: true}},
                    currentDispatch: {
                        include: {
                            participants: {
                                include: {user: {select: {id: true, name: true, phone: true}}},
                            },
                        },
                    },
                },
            }),
            this.prisma.order.count({where}),
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
            where: {id},
            include: {
                project: true,
                dispatcher: {select: {id: true, name: true, phone: true}},

                // ✅ 当前派单批次
                currentDispatch: {
                    include: {
                        participants: {
                            where: {isActive: true}, // ✅ 只取当前有效参与者
                            include: {
                                user: {select: {id: true, name: true, phone: true, workStatus: true}}, // ✅ 关键：把 user 带出来
                            },
                            orderBy: {id: 'asc'},
                        },
                    },
                },

                // ✅ 历史批次（详情页展示派单历史 & 接单明细）
                dispatches: {
                    orderBy: {round: 'desc'},
                    include: {
                        participants: {
                            include: {
                                user: {select: {id: true, name: true, phone: true}},
                            },
                            orderBy: {id: 'asc'},
                        },
                    },
                },

                // ✅ 结算明细（可选：如果你详情页要展示）
                settlements: {
                    include: {
                        user: {select: {id: true, name: true, phone: true}},
                    },
                    orderBy: {id: 'desc'},
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
            where: {id: orderId},
            include: {currentDispatch: true, project: true},
        });
        if (!order) throw new NotFoundException('订单不存在');

        // 若已退款等终态，可禁用派单（你后续可按业务扩展）
        if (order.status === OrderStatus.REFUNDED) {
            throw new ForbiddenException('已退款订单不可派单');
        }

        // 如果有 currentDispatch
        if (order.currentDispatchId) {
            const dispatch = await this.prisma.orderDispatch.findUnique({
                where: {id: order.currentDispatchId},
                include: {participants: true},
            });
            if (!dispatch) throw new NotFoundException('当前派单批次不存在');

            if (dispatch.status !== DispatchStatus.WAIT_ASSIGN) {
                throw new ForbiddenException('当前状态不可修改参与者（仅待派单可修改）');
            }

            // 更新参与者：简单策略 = 删除后重建（仅 WAIT_ASSIGN 阶段，没有历史价值）
            await this.prisma.orderParticipant.deleteMany({where: {dispatchId: dispatch.id}});
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
                where: {id: dispatch.id},
                data: {
                    status: DispatchStatus.WAIT_ACCEPT,
                    assignedAt: new Date(),
                    remark: dto.remark ?? dispatch.remark ?? null,
                },
                include: {
                    participants: {include: {user: {select: {id: true, name: true, phone: true}}}},
                },
            });

            const updatedOrder = await this.prisma.order.update({
                where: {id: order.id},
                data: {
                    status: OrderStatus.WAIT_ACCEPT,
                },
            });

            await this.logOrderAction(operatorId, order.id, 'ASSIGN_DISPATCH', {
                dispatchId: updatedDispatch.id,
                players: dto.playerIds,
            });

            return {order: updatedOrder, dispatch: updatedDispatch};
        }

        // 如果没有 currentDispatch：创建 round=1
        const lastDispatch = await this.prisma.orderDispatch.findFirst({
            where: {orderId},
            orderBy: {round: 'desc'},
            select: {round: true},
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
                participants: {include: {user: {select: {id: true, name: true, phone: true}}}},
            },
        });

        await this.prisma.order.update({
            where: {id: orderId},
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
            where: {id: dispatchId},
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
            where: {id: participant.id},
            data: {acceptedAt: new Date()},
        });

        await this.prisma.user.update({
            where: {id: userId},
            data: {workStatus: 'WORKING' as any},
        });

        // 判断是否全员接单完成
        const refreshed = await this.prisma.orderDispatch.findUnique({
            where: {id: dispatchId},
            include: {participants: true, order: true},
        });
        if (!refreshed) throw new NotFoundException('派单批次不存在');

        const active = (refreshed.participants || []).filter((p: any) => p?.isActive !== false && !p?.rejectedAt);
        const allAccepted = active.length > 0 && active.every((p: any) => !!p.acceptedAt);

        if (allAccepted && refreshed.status !== DispatchStatus.ACCEPTED) {
            await this.prisma.orderDispatch.update({
                where: {id: dispatchId},
                data: {
                    status: DispatchStatus.ACCEPTED,
                    acceptedAllAt: new Date(),
                },
            });

            await this.prisma.order.update({
                where: {id: refreshed.orderId},
                data: {status: OrderStatus.ACCEPTED},
            });
        }

        const remark = typeof payload === 'string' ? payload : payload?.remark;

        await this.logOrderAction(userId, refreshed.orderId, 'ACCEPT_DISPATCH', {
            dispatchId,
            remark: remark ?? null,
        });

        return this.getDispatchWithParticipants(dispatchId);
    }

    /**
     * 陪玩拒单（待接单阶段）
     * - 必填拒单原因
     * - participant 标记 rejectedAt + rejectReason，并置 isActive=false 进入历史
     */
    async rejectDispatch(dispatchId: number, userId: number, reason: string) {
        dispatchId = Number(dispatchId);
        userId = Number(userId);
        reason = String(reason ?? '').trim();

        if (!dispatchId) throw new BadRequestException('dispatchId 必填');
        if (!userId) throw new ForbiddenException('未登录或无权限操作');
        if (!reason) throw new BadRequestException('reason 必填');

        const dispatch = await this.prisma.orderDispatch.findUnique({
            where: {id: dispatchId},
            include: {order: true, participants: true},
        });
        if (!dispatch) throw new NotFoundException('派单批次不存在');

        if (dispatch.status !== DispatchStatus.WAIT_ACCEPT) {
            throw new ForbiddenException('当前派单状态不可拒单');
        }

        const participant = dispatch.participants.find((p: any) => Number(p.userId) === userId && p.isActive !== false);
        if (!participant) throw new ForbiddenException('你不在本轮派单参与者中');
        if (participant.acceptedAt) throw new ForbiddenException('已接单，不能拒单');
        if (participant.rejectedAt) throw new ForbiddenException('已拒单，无需重复操作');

        const now = new Date();

        await this.prisma.orderParticipant.update({
            where: {id: participant.id},
            data: {
                rejectedAt: now,
                rejectReason: reason,
                isActive: false,
            } as any,
        });

        // 拒单后保持空闲
        await this.prisma.user.update({
            where: {id: userId},
            data: {workStatus: PlayerWorkStatus.IDLE as any},
        });

        await this.logOrderAction(userId, dispatch.orderId, 'REJECT_DISPATCH', {
            dispatchId,
            reason,
        });

        return this.getDispatchWithParticipants(dispatchId);
    }

    /**
     * 修改存单记录保底进度（仅 ARCHIVED 轮次允许）
     * - 如本轮已有结算明细：会重算本轮结算（未打款才允许）
     */
    async updateArchivedParticipantProgress(
        dispatchId: number,
        participantId: number,
        progressBaseWan: number,
        operatorId: number,
        remark?: string,
    ) {
        dispatchId = Number(dispatchId);
        participantId = Number(participantId);
        operatorId = Number(operatorId);
        progressBaseWan = Number(progressBaseWan);

        if (!dispatchId) throw new BadRequestException('dispatchId 必填');
        if (!participantId) throw new BadRequestException('participantId 必填');
        if (!Number.isFinite(progressBaseWan)) throw new BadRequestException('progressBaseWan 非法');
        if (!operatorId) throw new ForbiddenException('未登录或无权限操作');

        const dispatch = await this.prisma.orderDispatch.findUnique({
            where: {id: dispatchId},
            include: {
                order: true,
                participants: true,
                settlements: {select: {id: true, paymentStatus: true}},
            },
        });
        if (!dispatch) throw new NotFoundException('派单批次不存在');
        if (dispatch.status !== DispatchStatus.ARCHIVED) throw new ForbiddenException('仅存单(ARCHIVED)批次允许修改进度');

        const p = dispatch.participants.find((x: any) => Number(x.id) === participantId);
        if (!p) throw new NotFoundException('参与者记录不存在');

        // 已打款的不允许重算
        const hasPaid = (dispatch.settlements || []).some((s: any) => s.paymentStatus === PaymentStatus.PAID);
        if (hasPaid) throw new ForbiddenException('本轮存在已打款结算记录，禁止修改进度（请走财务冲正流程）');

        const before = p.progressBaseWan ?? null;

        await this.prisma.orderParticipant.update({
            where: {id: participantId},
            data: {progressBaseWan} as any,
        });

        // 重算本轮结算（删除旧的再生成新的）
        if ((dispatch.settlements || []).length > 0) {
            const settlementBatchId = randomUUID();

            await this.prisma.$transaction(async (tx) => {
                // 1) 删除旧结算（仅本 dispatch）
                await tx.orderSettlement.deleteMany({ where: { dispatchId } });

                // 2) 重新生成结算（仍按 ARCHIVE 模式：按进度比例）
                await this.createSettlementsForDispatch(
                    {
                        orderId: dispatch.orderId,
                        dispatchId,
                        mode: 'ARCHIVE',
                        settlementBatchId, // ✅ 新增：本次重算批次号
                    },
                    tx, // ✅ 新增：事务句柄
                );
            });
        }

        await this.logOrderAction(operatorId, dispatch.orderId, 'UPDATE_ARCHIVED_PROGRESS', {
            dispatchId,
            participantId,
            before,
            after: progressBaseWan,
            remark: remark ?? null,
        });

        return this.getOrderDetail(dispatch.orderId);
    }


    private async getDispatchWithParticipants(dispatchId: number) {
        return this.prisma.orderDispatch.findUnique({
            where: {id: dispatchId},
            include: {
                participants: {include: {user: {select: {id: true, name: true, phone: true}}}},
                order: {select: {id: true, autoSerial: true, status: true}},
            },
        });
    }

    // -----------------------------
    // 5) 存单（ARCHIVED）——本轮生成结算明细（按进度比例）
    // -----------------------------
    async archiveDispatch(dispatchId: number, operatorId: number, dto: ArchiveDispatchDto) {
        const orderId = await this.prisma.$transaction(
            async (tx) => {
                await this.lockDispatchForSettlementOrThrow(dispatchId, tx);

                const settlementBatchId = randomUUID();

                const dispatch = await tx.orderDispatch.findUnique({
                    where: { id: dispatchId },
                    include: {
                        order: { include: { project: true } },
                        participants: true,
                    },
                });

                if (!dispatch) throw new BadRequestException('派单批次不存在');

                const now = new Date();

                await this.applyProgressAndDeduct(tx, dispatch, dto);

                const billingResult = await this.computeAndPersistBillingHours(
                    tx,
                    dispatch,
                    'ARCHIVE',
                    now,
                    dto.deductMinutesOption,
                );

                await tx.orderDispatch.update({
                    where: { id: dispatchId },
                    data: {
                        status: DispatchStatus.ARCHIVED,
                        archivedAt: now,
                        remark: dto.remark ?? dispatch.remark ?? null,
                    },
                });

                await this.createSettlementsForDispatch(
                    { orderId: dispatch.orderId, dispatchId, mode: 'ARCHIVE', settlementBatchId },
                    tx,
                );

                await tx.orderParticipant.updateMany({
                    where: { dispatchId },
                    data: { isActive: false },
                });

                // ✅ 存单：一般需要让订单可继续派下一轮
                await tx.order.update({
                    where: { id: dispatch.orderId },
                    data: { status: OrderStatus.ARCHIVED },
                });

                const userIds = dispatch.participants.map((p) => p.userId);
                await tx.user.updateMany({
                    where: { id: { in: userIds } },
                    data: { workStatus: 'IDLE' as any },
                });

                await this.logOrderAction(
                    operatorId,
                    dispatch.orderId,
                    'ARCHIVE_DISPATCH',
                    { dispatchId, billing: billingResult, settlementBatchId },
                    tx,
                );

                return dispatch.orderId;
            },
            { maxWait: 5000, timeout: 20000 },
        );

        return this.getOrderDetail(orderId);
    }


    // -----------------------------
    // 6) 结单（COMPLETED）——结单即自动结算落库
    // -----------------------------
    async completeDispatch(dispatchId: number, operatorId: number, dto: CompleteDispatchDto) {
        const orderId = await this.prisma.$transaction(
            async (tx) => {
                // ✅ 0) 互斥锁：ACCEPTED -> SETTLING
                await this.lockDispatchForSettlementOrThrow(dispatchId, tx);

                const settlementBatchId = randomUUID();

                // ✅ 2) 读取 dispatch（事务内一致性）
                const dispatch = await tx.orderDispatch.findUnique({
                    where: { id: dispatchId },
                    include: {
                        order: { include: { project: true } },
                        participants: true,
                    },
                });

                if (!dispatch) throw new BadRequestException('派单批次不存在');

                const now = new Date();

                // ✅ 4) progress 写入（tx）
                await this.applyProgressAndDeduct(tx, dispatch, dto);

                // ✅ 5) 小时单计费落库（tx）
                const billingResult = await this.computeAndPersistBillingHours(
                    tx,
                    dispatch,
                    'COMPLETE',
                    now,
                    dto.deductMinutesOption,
                );

                // ✅ 6) dispatch -> COMPLETED
                await tx.orderDispatch.update({
                    where: { id: dispatchId },
                    data: {
                        status: DispatchStatus.COMPLETED,
                        completedAt: now,
                        remark: dto.remark ?? dispatch.remark ?? null,
                    },
                });

                // ✅ 7) 结算（必须 tx，且在置历史前）
                await this.createSettlementsForDispatch(
                    { orderId: dispatch.orderId, dispatchId, mode: 'COMPLETE', settlementBatchId },
                    tx,
                );

                // ✅ 8) participants -> history
                await tx.orderParticipant.updateMany({
                    where: { dispatchId },
                    data: { isActive: false },
                });

                // ✅ 9) 订单状态更新（你要求第9步在文件里，我这里给出稳定默认：结单 => COMPLETED）
                // ⚠️ 如果你原逻辑是“当所有 dispatch 完成才 completed”，把你原逻辑粘回来，但必须用 tx。
                await tx.order.update({
                    where: { id: dispatch.orderId },
                    data: { status: OrderStatus.COMPLETED },
                });

                // ✅ 10) 打手空闲
                const userIds = dispatch.participants.map((p) => p.userId);
                await tx.user.updateMany({
                    where: { id: { in: userIds } },
                    data: { workStatus: 'IDLE' as any },
                });

                // ✅ 11) 日志（tx）
                await this.logOrderAction(
                    operatorId,
                    dispatch.orderId,
                    'COMPLETE_DISPATCH',
                    { dispatchId, billing: billingResult, settlementBatchId },
                    tx,
                );

                return dispatch.orderId;
            },
            { maxWait: 5000, timeout: 20000 },
        );

        // ✅ 事务外拉详情（避免慢查询拖死事务）
        return this.getOrderDetail(orderId);
    }


    /**
     * 写入保底进度 / 扣时选项
     * - 保底单：写 participants.progressBaseWan（允许负数）
     * - 小时单：仅记录 deductMinutesOption（实际计算在 computeAndPersistBillingHours）
     */
    private async applyProgressAndDeduct(
        tx: any,
        dispatch: any,
        dto: { progresses?: Array<{ userId: number; progressBaseWan?: number }>; deductMinutesOption?: string },
    ) {
        // ✅ 只处理 progress（保底单）；小时单扣时由 computeAndPersistBillingHours 统一计算并落库
        if (!dto.progresses || dto.progresses.length === 0) return;

        // 小优化：转 Map，避免查找 O(n^2)
        const map = new Map<number, number | null>();
        for (const p of dto.progresses) {
            map.set(p.userId, p.progressBaseWan ?? null);
        }

        // ✅ participants 通常最多 2 人，你逐条 update 其实非常快
        // 若你未来支持更多人，也可以考虑批量 update（需要 CASE WHEN 写法，不建议 Prisma 做）
        for (const part of dispatch.participants) {
            if (map.has(part.userId)) {
                await tx.orderParticipant.update({
                    where: { id: part.id },
                    data: { progressBaseWan: map.get(part.userId) },
                });
            }
        }
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
        tx: any,
        dispatch: any,
        action: 'ARCHIVE' | 'COMPLETE',
        endTime: Date,
        deductMinutesOption?: string,
    ) {
        const billingMode = dispatch?.order?.project?.billingMode;
        if (billingMode !== BillingMode.HOURLY) return null;

        if (!dispatch.acceptedAllAt) {
            throw new BadRequestException('小时单缺少全员接单时间，无法计算时长');
        }

        const deductValue = this.mapDeductMinutesValue(deductMinutesOption);
        const rawMinutes = Math.max(
            0,
            Math.floor((endTime.getTime() - dispatch.acceptedAllAt.getTime()) / 60000),
        );

        const effectiveMinutes = Math.max(0, rawMinutes - deductValue);
        const billableHours = this.minutesToBillableHours(effectiveMinutes);

        await tx.orderDispatch.update({
            where: { id: dispatch.id },
            data: {
                deductMinutes: deductMinutesOption as any,
                deductMinutesValue: deductValue || null,
                billableMinutes: effectiveMinutes,
                billableHours,
            },
        });

        return { action, rawMinutes, deductValue, effectiveMinutes, billableHours };
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

    /**
     * ✅ 为某一轮派单生成结算明细（存单 / 结单都会走）
     *
     * 设计要点：
     * 1) ❌ 不在内部开启 transaction
     *    - 外层（archiveDispatch / completeDispatch）已经在 $transaction 中
     *    - 避免 Prisma 嵌套事务失效导致“部分提交”
     *
     * 2) ✅ settlementBatchId：本轮结算唯一批次号
     *    - 用于追溯 / 对账 / 未来微信打款
     *
     * 3) ✅ 使用 upsert + schema @@unique
     *    - 防止并发 / 重试 / 一个结单一个存单导致重复结算
     *
     * 4) ✅ settlement + 钱包冻结必须在同一个 tx 中
     */
    // async createSettlementsForDispatch(
    //     params: {
    //         orderId: number;
    //         dispatchId: number;
    //         mode: 'ARCHIVE' | 'COMPLETE';
    //         settlementBatchId: string; // ✅ 结算批次号
    //     },
    //     tx: any, // ✅ 外层事务
    // ) {
    //     const { orderId, dispatchId, mode, settlementBatchId } = params;
    //
    //     // ===========================
    //     // v0.2 测试参数：冻结时间用“分钟”
    //     // ✅ 后续上线再改回“天 / 按等级配置”
    //     // ===========================
    //     // const EXPERIENCE_UNLOCK_MINUTES = 3 * 24 * 60;
    //     // const REGULAR_UNLOCK_MINUTES = 7 * 24 * 60;
    //     const EXPERIENCE_UNLOCK_MINUTES = 5;
    //     const REGULAR_UNLOCK_MINUTES = 30;
    //
    //     // ===========================
    //     // 客服分红比例（不落库，纯规则）
    //     // ===========================
    //     const CUSTOMER_SERVICE_SHARE_RATE = 0.01;
    //
    //     // 1️⃣ 读取订单 & 派单（必须用 tx）
    //     const order = await tx.order.findUnique({
    //         where: { id: orderId },
    //         include: { project: true },
    //     });
    //     if (!order) throw new NotFoundException('订单不存在');
    //
    //     const dispatch = await tx.orderDispatch.findUnique({
    //         where: { id: dispatchId },
    //         include: { participants: true },
    //     });
    //     if (!dispatch) throw new NotFoundException('派单批次不存在');
    //
    //     // 2️⃣ 本轮参与者（只结算 active 的，避免历史重复结算）
    //     const participants = dispatch.participants.filter((p) => p.isActive);
    //     if (participants.length === 0) return true;
    //
    //     // 3️⃣ 本轮结算类型（体验单 / 正价单）
    //     const settlementType = order.type === OrderType.EXPERIENCE ? 'EXPERIENCE' : 'REGULAR';
    //
    //     // 解冻时间
    //     const unlockAt =
    //         settlementType === 'EXPERIENCE'
    //             ? new Date(Date.now() + EXPERIENCE_UNLOCK_MINUTES * 60 * 1000)
    //             : new Date(Date.now() + REGULAR_UNLOCK_MINUTES * 60 * 1000);
    //
    //     // 4️⃣ 分摊规则（原有逻辑，保持）
    //     // ✅ ARCHIVE 按 progress 比例分摊：ratioMap key 为 participant.id
    //     const ratioMap = this.buildProgressRatioMap(participants);
    //
    //     const dispatchCount = await tx.orderDispatch.count({
    //         where: { orderId },
    //     });
    //
    //     const hasOrderCut = Number(order.cutRate ?? 0) > 0;
    //     const hasProjectCut = Number(order.project?.cutRate ?? 0) > 0;
    //
    //     // ===========================
    //     // 5️⃣ 逐个陪玩生成结算（幂等）
    //     // ✅ 优化：从 “串行 for-await” 改为 Promise.all 并发
    //     // ===========================
    //     await Promise.all(
    //         participants.map(async (p) => {
    //             const userId = p.userId;
    //
    //             const ratio = ratioMap.get(p.id) ?? 1;
    //             const calculated = this.calcPlayerEarning({
    //                 order,
    //                 participantsCount: participants.length,
    //                 ratio,
    //             });
    //
    //             // 平台抽成 / 项目抽成 / 分红比例优先级（原逻辑）
    //             const multiplier = this.resolveMultiplier(order, p);
    //             const final = this.round1(calculated * multiplier);
    //
    //             // === 5.2 结算 upsert（核心幂等点） ===
    //             const settlement = await tx.orderSettlement.upsert({
    //                 where: {
    //                     // ✅ schema：@@unique([dispatchId, userId, settlementType])
    //                     dispatchId_userId_settlementType: {
    //                         dispatchId,
    //                         userId,
    //                         settlementType,
    //                     },
    //                 },
    //                 create: {
    //                     orderId,
    //                     dispatchId,
    //                     userId,
    //                     settlementType,
    //                     settlementBatchId, // ✅ 批次号
    //                     calculatedEarnings: calculated,
    //                     manualAdjustment: final - calculated,
    //                     finalEarnings: final,
    //                     clubEarnings: calculated - final,
    //                     csEarnings: null,
    //                     inviteEarnings: null,
    //                     paymentStatus: PaymentStatus.UNPAID,
    //                 },
    //                 update: {
    //                     // ✅ 幂等策略：不覆盖人工调整，只补 batchId
    //                     settlementBatchId,
    //                 },
    //             });
    //
    //             // === 5.3 钱包冻结（同一 tx，依赖 settlement.id 的唯一性） ===
    //             // ✅ 这里也保持幂等：wallet 内部通常以 sourceType+sourceId 或类似唯一键防重复
    //             await this.wallet.createFrozenSettlementEarning(
    //                 {
    //                     userId,
    //                     amount: settlement.finalEarnings,
    //                     unlockAt,
    //                     sourceType: 'ORDER_SETTLEMENT',
    //                     sourceId: settlement.id, // ✅ 幂等锚点
    //                     orderId,
    //                     dispatchId,
    //                     settlementId: settlement.id,
    //                 },
    //                 tx,
    //             );
    //         }),
    //     );
    //
    //     // ===========================
    //     // 6️⃣ 客服分红（如有）
    //     // ✅ 优化：独立块，逻辑保持，仍在事务内
    //     // ===========================
    //     if (CUSTOMER_SERVICE_SHARE_RATE > 0 && order.dispatcherId) {
    //         const csAmount = this.round1(order.paidAmount * CUSTOMER_SERVICE_SHARE_RATE);
    //         if (csAmount > 0) {
    //             const csSettlement = await tx.orderSettlement.upsert({
    //                 where: {
    //                     dispatchId_userId_settlementType: {
    //                         dispatchId,
    //                         userId: order.dispatcherId,
    //                         settlementType: 'CUSTOMER_SERVICE',
    //                     },
    //                 },
    //                 create: {
    //                     orderId,
    //                     dispatchId,
    //                     userId: order.dispatcherId,
    //                     settlementType: 'CUSTOMER_SERVICE',
    //                     settlementBatchId,
    //                     calculatedEarnings: csAmount,
    //                     manualAdjustment: 0,
    //                     finalEarnings: csAmount,
    //                     paymentStatus: PaymentStatus.UNPAID,
    //                 },
    //                 update: { settlementBatchId },
    //             });
    //
    //             await this.wallet.createFrozenSettlementEarning(
    //                 {
    //                     userId: order.dispatcherId,
    //                     amount: csSettlement.finalEarnings,
    //                     unlockAt,
    //                     sourceType: 'ORDER_SETTLEMENT',
    //                     sourceId: csSettlement.id,
    //                     orderId,
    //                     dispatchId,
    //                     settlementId: csSettlement.id,
    //                 },
    //                 tx,
    //             );
    //         }
    //     }
    //
    //     // ===========================
    //     // 7️⃣ 聚合回写订单（你原有逻辑，保持）
    //     // ===========================
    //     const agg = await tx.orderSettlement.aggregate({
    //         where: { orderId },
    //         _sum: {
    //             finalEarnings: true,
    //             clubEarnings: true,
    //         },
    //     });
    //
    //     await tx.order.update({
    //         where: { id: orderId },
    //         data: {
    //             totalPlayerEarnings: Number(agg._sum.finalEarnings ?? 0),
    //             clubEarnings: Number(agg._sum.clubEarnings ?? 0),
    //         },
    //     });
    //
    //     // ===========================
    //     // 8️⃣ 操作日志（你原有逻辑，保持）
    //     // ===========================
    //     await this.logOrderAction(
    //         order.dispatcherId,
    //         orderId,
    //         mode === 'ARCHIVE' ? 'SETTLE_ARCHIVE' : 'SETTLE_COMPLETE',
    //         {
    //             dispatchId,
    //             settlementBatchId,
    //             rule:
    //                 dispatchCount === 1 && mode === 'COMPLETE'
    //                     ? 'SINGLE_COMPLETE_FULL'
    //                     : 'RATIO_BY_PROGRESS',
    //             multiplierPriority: hasOrderCut
    //                 ? 'ORDER_CUT'
    //                 : hasProjectCut
    //                     ? 'PROJECT_CUT'
    //                     : 'PLAYER_SHARE',
    //         },
    //     );
    //
    //     return true;
    // }

    async createSettlementsForDispatch(
        params: {
            orderId: number;
            dispatchId: number;
            mode: 'ARCHIVE' | 'COMPLETE';
            settlementBatchId: string;
        },
        tx: any,
    ) {
        const { orderId, dispatchId, mode, settlementBatchId } = params;

        // ===========================
        // v0.2 测试参数：冻结时间用“分钟”
        // ===========================
        const EXPERIENCE_UNLOCK_MINUTES = 5;
        const REGULAR_UNLOCK_MINUTES = 30;

        // ===========================
        // 客服分红比例
        // ===========================
        const CUSTOMER_SERVICE_SHARE_RATE = 0.01;

        // ---------- 工具函数 ----------
        const normalizeToRatio = (v: any, fallback: number) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            return n > 1 ? n / 100 : n; // 兼容 10 / 0.1 / 60 / 0.6
        };
        const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
        const isSet = (v: any) => v !== null && v !== undefined; // ✅ 关键：0 也算“已设置”

        // 1️⃣ 读取订单 & 派单
        const order = await tx.order.findUnique({
            where: { id: orderId },
            include: { project: true },
        });
        if (!order) throw new NotFoundException('订单不存在');

        const dispatch = await tx.orderDispatch.findUnique({
            where: { id: dispatchId },
            include: { participants: true },
        });
        if (!dispatch) throw new NotFoundException('派单批次不存在');

        // 2️⃣ 本轮参与者（active）
        const participants = dispatch.participants.filter((p) => p.isActive);
        if (participants.length === 0) return true;

        // 3️⃣ 结算类型
        const settlementType = order.type === OrderType.EXPERIENCE ? 'EXPERIENCE' : 'REGULAR';

        const unlockAt =
            settlementType === 'EXPERIENCE'
                ? new Date(Date.now() + EXPERIENCE_UNLOCK_MINUTES * 60 * 1000)
                : new Date(Date.now() + REGULAR_UNLOCK_MINUTES * 60 * 1000);

        // 4️⃣ 分摊规则（保持你现有的 progress ratio）
        const ratioMap = this.buildProgressRatioMap(participants);
        const dispatchCount = await tx.orderDispatch.count({ where: { orderId } });

        // ✅ 订单抽成优先：customClubRate > clubRate（两者都算“订单抽成设置”）
        const orderCutRaw = isSet(order.customClubRate) ? order.customClubRate : (isSet(order.clubRate) ? order.clubRate : null);

        // ✅ 项目抽成：快照优先（projectSnapshot.clubRate），否则项目配置 project.clubRate
        const snap: any = order.projectSnapshot ?? {};
        const projectCutRaw = isSet(snap.clubRate) ? snap.clubRate : (isSet(order.project?.clubRate) ? order.project.clubRate : null);

        // ✅ 批量拉员工评级（只在“订单未设置 && 项目未设置”时才需要）
        let shareMap: Map<number, number> | null = null;
        if (!isSet(orderCutRaw) && !isSet(projectCutRaw)) {
            const userIds = participants.map((p) => p.userId);
            const users = await tx.user.findMany({
                where: { id: { in: userIds } },
                select: { id: true, staffRating: { select: { rate: true } } },
            });
            shareMap = new Map<number, number>();
            for (const u of users) {
                shareMap.set(u.id, clamp01(normalizeToRatio(u.staffRating?.rate, 1))); // 默认 100%
            }
        }

        // ✅ 统一计算 multiplier：严格按你给的优先级与“0 也算已设置”
        const getMultiplier = (userId: number) => {
            // 1) 订单抽成（含 0）
            if (isSet(orderCutRaw)) {
                const cut = clamp01(normalizeToRatio(orderCutRaw, 0));
                return clamp01(1 - cut);
            }

            // 2) 项目抽成（含 0）
            if (isSet(projectCutRaw)) {
                const cut = clamp01(normalizeToRatio(projectCutRaw, 0));
                return clamp01(1 - cut);
            }

            // 3) 员工评级分红
            return clamp01(shareMap?.get(userId) ?? 1);
        };

        // ✅ 日志用：实际命中的优先级
        const multiplierPriority = isSet(orderCutRaw) ? 'ORDER_CUT' : isSet(projectCutRaw) ? 'PROJECT_CUT' : 'PLAYER_SHARE';

        // ===========================
        // 5️⃣ 批量幂等写 settlement + 冻结钱包（并发 + 可重算）
        // ===========================

        // 5.0 先查已有 settlement（避免 upsert update 不重算的问题）
        const userIds = participants.map((p) => p.userId);
        const existing = await tx.orderSettlement.findMany({
            where: { dispatchId, settlementType, userId: { in: userIds } },
            select: { id: true, userId: true, paymentStatus: true, manualAdjustment: true, finalEarnings: true },
        });
        const existMap = new Map<number, any>();
        for (const e of existing) existMap.set(e.userId, e);

        // 5.1 并发处理每个参与者
        await Promise.all(
            participants.map(async (p) => {
                const ratio = ratioMap.get(p.id) ?? 1;
                const calculated = this.calcPlayerEarning({
                    order,
                    participantsCount: participants.length,
                    ratio,
                });

                const multiplier = getMultiplier(p.userId);
                const final = this.round1(calculated * multiplier);

                const found = existMap.get(p.userId);

                // ✅ 可重算规则：未打款 且 未人工调整（manualAdjustment=0）
                const canRecalc =
                    !found ||
                    (found.paymentStatus === PaymentStatus.UNPAID && Number(found.manualAdjustment ?? 0) === 0);

                let settlementId: number;

                if (!found) {
                    const created = await tx.orderSettlement.create({
                        data: {
                            orderId,
                            dispatchId,
                            userId: p.userId,
                            settlementType,
                            settlementBatchId,

                            calculatedEarnings: calculated,
                            manualAdjustment: final - calculated,
                            finalEarnings: final,
                            clubEarnings: calculated - final,

                            csEarnings: null,
                            inviteEarnings: null,

                            paymentStatus: PaymentStatus.UNPAID,
                        },
                        select: { id: true, finalEarnings: true },
                    });

                    settlementId = created.id;

                    await this.wallet.createFrozenSettlementEarning(
                        {
                            userId: p.userId,
                            amount: created.finalEarnings,
                            unlockAt,
                            sourceType: 'ORDER_SETTLEMENT',
                            sourceId: created.id,
                            orderId,
                            dispatchId,
                            settlementId: created.id,
                        },
                        tx,
                    );

                    return;
                }

                settlementId = found.id;

                if (canRecalc) {
                    const updated = await tx.orderSettlement.update({
                        where: { id: settlementId },
                        data: {
                            settlementBatchId,
                            calculatedEarnings: calculated,
                            manualAdjustment: final - calculated,
                            finalEarnings: final,
                            clubEarnings: calculated - final,
                        },
                        select: { id: true, finalEarnings: true },
                    });

                    // ✅ 冻结也要幂等：wallet 内部应以 sourceType+sourceId 去重
                    await this.wallet.createFrozenSettlementEarning(
                        {
                            userId: p.userId,
                            amount: updated.finalEarnings,
                            unlockAt,
                            sourceType: 'ORDER_SETTLEMENT',
                            sourceId: updated.id,
                            orderId,
                            dispatchId,
                            settlementId: updated.id,
                        },
                        tx,
                    );
                } else {
                    // 不覆盖人工调整/已支付：只补 batchId（保持你原策略）
                    await tx.orderSettlement.update({
                        where: { id: settlementId },
                        data: { settlementBatchId },
                    });

                    // ✅ 这里不做钱包调整（避免覆盖人工/已支付）
                }
            }),
        );

        // ===========================
        // 6️⃣ 客服分红
        // ===========================
        if (CUSTOMER_SERVICE_SHARE_RATE > 0 && order.dispatcherId) {
            const csAmount = this.round1((order.paidAmount ?? 0) * CUSTOMER_SERVICE_SHARE_RATE);
            if (csAmount > 0) {
                const csFound = await tx.orderSettlement.findUnique({
                    where: {
                        dispatchId_userId_settlementType: {
                            dispatchId,
                            userId: order.dispatcherId,
                            settlementType: 'CUSTOMER_SERVICE',
                        },
                    },
                    select: { id: true, paymentStatus: true, manualAdjustment: true },
                });

                if (!csFound) {
                    const created = await tx.orderSettlement.create({
                        data: {
                            orderId,
                            dispatchId,
                            userId: order.dispatcherId,
                            settlementType: 'CUSTOMER_SERVICE',
                            settlementBatchId,
                            calculatedEarnings: csAmount,
                            manualAdjustment: 0,
                            finalEarnings: csAmount,
                            paymentStatus: PaymentStatus.UNPAID,
                        },
                        select: { id: true, finalEarnings: true },
                    });

                    await this.wallet.createFrozenSettlementEarning(
                        {
                            userId: order.dispatcherId,
                            amount: created.finalEarnings,
                            unlockAt,
                            sourceType: 'ORDER_SETTLEMENT',
                            sourceId: created.id,
                            orderId,
                            dispatchId,
                            settlementId: created.id,
                        },
                        tx,
                    );
                } else {
                    const canRecalc =
                        csFound.paymentStatus === PaymentStatus.UNPAID && Number(csFound.manualAdjustment ?? 0) === 0;

                    if (canRecalc) {
                        const updated = await tx.orderSettlement.update({
                            where: { id: csFound.id },
                            data: {
                                settlementBatchId,
                                calculatedEarnings: csAmount,
                                finalEarnings: csAmount,
                                clubEarnings: 0,
                                manualAdjustment: 0,
                            },
                            select: { id: true, finalEarnings: true },
                        });

                        await this.wallet.createFrozenSettlementEarning(
                            {
                                userId: order.dispatcherId,
                                amount: updated.finalEarnings,
                                unlockAt,
                                sourceType: 'ORDER_SETTLEMENT',
                                sourceId: updated.id,
                                orderId,
                                dispatchId,
                                settlementId: updated.id,
                            },
                            tx,
                        );
                    } else {
                        await tx.orderSettlement.update({
                            where: { id: csFound.id },
                            data: { settlementBatchId },
                        });
                    }
                }
            }
        }

        // ===========================
        // 7️⃣ 聚合回写订单
        // ===========================
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

        // ===========================
        // 8️⃣ 操作日志（建议也传 tx，避免事务内外混用）
        // ===========================
        await this.logOrderAction(
            order.dispatcherId,
            orderId,
            mode === 'ARCHIVE' ? 'SETTLE_ARCHIVE' : 'SETTLE_COMPLETE',
            {
                dispatchId,
                settlementBatchId,
                rule: dispatchCount === 1 && mode === 'COMPLETE' ? 'SINGLE_COMPLETE_FULL' : 'RATIO_BY_PROGRESS',
                multiplierPriority,
                orderCut: isSet(orderCutRaw) ? normalizeToRatio(orderCutRaw, 0) : null,
                projectCut: !isSet(orderCutRaw) && isSet(projectCutRaw) ? normalizeToRatio(projectCutRaw, 0) : null,
            },
            tx,
        );

        return true;
    }


    private capProgress(progress: number, base: number): number {
        if (progress > base) return base;
        if (progress < -base) return -base;
        return progress;
    }

    private async sumDispatchProgressWan(dispatchId: number): Promise<number> {
        const parts = await this.prisma.orderParticipant.findMany({
            where: {dispatchId},
            select: {progressBaseWan: true},
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
                settledAt: {gte: start, lt: end},
                settlementType: batchType === 'EXPERIENCE_3DAY' ? 'EXPERIENCE' : 'REGULAR',
            },
            include: {
                user: {select: {id: true, name: true, phone: true}},
                order: {select: {id: true, paidAmount: true, clubEarnings: true}},
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
            where: {id: {in: dto.settlementIds}},
            select: {id: true, orderId: true, userId: true, finalEarnings: true, paymentStatus: true},
        });

        if (settlements.length === 0) throw new NotFoundException('未找到结算记录');

        await this.prisma.orderSettlement.updateMany({
            where: {id: {in: dto.settlementIds}, paymentStatus: PaymentStatus.UNPAID},
            data: {paymentStatus: PaymentStatus.PAID, paidAt: now},
        });

        const grouped = new Map<number, any[]>();
        for (const s of settlements) {
            grouped.set(s.orderId, [...(grouped.get(s.orderId) ?? []), s]);
        }

        for (const [orderId, list] of grouped) {
            await this.logOrderAction(operatorId, orderId, 'MARK_PAID', {
                settlements: list.map((x) => ({id: x.id, userId: x.userId, amount: x.finalEarnings})),
                remark: dto.remark ?? null,
            });
        }

        return {message: '打款状态更新成功', count: dto.settlementIds.length};
    }

    // -----------------------------
    // 9) 陪玩查询自己的记录
    // -----------------------------

    async listMyParticipations(userId: number) {
        return this.prisma.orderParticipant.findMany({
            where: {userId},
            orderBy: {id: 'desc'},
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
            where: {userId},
            orderBy: {settledAt: 'desc'},
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

    private async logOrderAction(
        operatorId: number,
        orderId: number,
        action: string,
        newData: any,
        tx?: any,
    ) {
        const uid = Number(operatorId);
        if (!uid) {
            throw new ForbiddenException('缺少操作人身份（operatorId），请重新登录后重试');
        }

        const db = tx ?? this.prisma;

        await db.userLog.create({
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
            where: {id: orderId},
            select: {id: true, status: true},
        });

        if (!order) throw new NotFoundException('订单不存在');

        const forbidden = new Set(['COMPLETED', 'REFUNDED']);
        if (forbidden.has(String(order.status))) {
            throw new ForbiddenException('当前订单状态不可取消');
        }

        const updated = await this.prisma.order.update({
            where: {id: orderId},
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
                    oldData: {status: order.status} as any,
                    newData: {status: 'CANCELLED'} as any,
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
            where: {id: orderId},
            include: {dispatches: {select: {id: true, round: true, status: true}}},
        });

        if (!order) throw new NotFoundException('订单不存在');

        // ✅ 防重复派单：若存在当前派单批次且仍处于待接/已接阶段，则禁止再次创建新一轮派单
        if (order.currentDispatchId) {
            const cur = await this.prisma.orderDispatch.findUnique({
                where: {id: order.currentDispatchId},
                include: {participants: true},
            });

            if (cur && [DispatchStatus.WAIT_ACCEPT, DispatchStatus.ACCEPTED].includes(cur.status as any)) {
                const activeParts = (cur.participants || []).filter((p: any) => p?.isActive !== false);
                // pending：未接单且未拒单
                const hasPending = activeParts.some((p: any) => !p?.acceptedAt && !p?.rejectedAt);
                if (hasPending) {
                    throw new ForbiddenException('当前订单存在未完成派单（待接单/已接单），禁止重复派单');
                }
            }
        }

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
            where: {id: orderId},
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
                    oldData: {status: order.status} as any,
                    newData: {status: 'WAIT_ACCEPT', playerIds, round: nextRound} as any,
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
            participants: {some: {userId}},
        };
        if (params.status) where.status = params.status as any;

        const [data, total] = await Promise.all([
            this.prisma.orderDispatch.findMany({
                where,
                skip,
                take: limit,
                orderBy: {id: 'desc'},
                include: {
                    order: {
                        include: {
                            project: true,
                            dispatcher: {select: {id: true, name: true, phone: true}},
                        },
                    },
                    participants: {
                        include: {
                            user: {select: {id: true, name: true, phone: true}},
                        },
                    },
                },
            }),
            this.prisma.orderDispatch.count({where}),
        ]);

        return {data, total, page, limit, totalPages: Math.ceil(total / limit)};
    }

    async updatePaidAmount(orderId: number, paidAmount: number, operatorId: number, remark?: string) {
        if (!orderId) throw new BadRequestException('id 必填');
        if (!Number.isFinite(paidAmount) || paidAmount < 0) throw new BadRequestException('paidAmount 非法');

        const order = await this.prisma.order.findUnique({
            where: {id: orderId},
            include: {project: true},
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
            where: {id: orderId},
            data: {paidAmount},
        });

        if (operatorId) {
            await this.prisma.userLog.create({
                data: {
                    userId: operatorId,
                    action: 'UPDATE_PAID_AMOUNT',
                    targetType: 'ORDER',
                    targetId: orderId,
                    oldData: {paidAmount: old} as any,
                    newData: {paidAmount} as any,
                    remark: remark || `小时单补收：${old} → ${paidAmount}`,
                },
            });
        }

        return updated;
    }

    async updateDispatchParticipants(
        dto: { dispatchId: number; playerIds: number[]; remark?: string },
        operatorId: number,
    ) {
        const dispatchId = Number(dto?.dispatchId);
        operatorId = Number(operatorId);

        if (!dispatchId) throw new BadRequestException('dispatchId 必填');
        if (!operatorId) throw new ForbiddenException('未登录或无权限操作');

        const targetUserIds = Array.isArray(dto?.playerIds)
            ? dto.playerIds.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
            : [];

        if (targetUserIds.length <= 0) {
            throw new BadRequestException('参与者不能为空');
        }

        // 去重
        const targetSet = new Set<number>(targetUserIds);
        const target = Array.from(targetSet);

        const now = new Date();

        await this.prisma.$transaction(async (tx) => {
            const dispatch = await tx.orderDispatch.findUnique({
                where: {id: dispatchId},
                include: {
                    order: {select: {id: true, status: true}},
                    participants: true,
                },
            });

            if (!dispatch) throw new NotFoundException('派单批次不存在');

            // 仅允许在 WAIT_ACCEPT/ACCEPTED 调整（你也可以只允许 WAIT_ACCEPT）
            if (![DispatchStatus.WAIT_ACCEPT, DispatchStatus.ACCEPTED].includes(dispatch.status as any)) {
                throw new ForbiddenException('当前派单状态不可修改参与者');
            }

            const existing = Array.isArray(dispatch.participants) ? dispatch.participants : [];

            // 参与者是否“有效参与本轮”的口径：isActive!=false 且未拒单
            const isActiveParticipant = (p: any) => p?.isActive !== false && !p?.rejectedAt;

            const existingByUserId = new Map<number, any>();
            for (const p of existing) existingByUserId.set(Number(p.userId), p);

            const activeUserIds = existing.filter(isActiveParticipant).map((p: any) => Number(p.userId));
            const activeSet = new Set<number>(activeUserIds);

            // 要移除的：当前活跃但目标里没有
            const toDeactivate = activeUserIds.filter((uid) => !targetSet.has(uid));

            // ✅ 规则 B：不允许取消已接单者
            // acceptedAt 有值即认为“已接单”
            const acceptedToRemove = toDeactivate
                .map((uid) => existingByUserId.get(uid))
                .filter((p) => p?.acceptedAt);

            if (acceptedToRemove.length > 0) {
                const names = acceptedToRemove
                    .map((p: any) => String(p?.userId))
                    .join(',');
                throw new ForbiddenException(`不允许取消已接单者：${names}`);
            }

            // 要恢复的：记录存在但当前非活跃/已拒单，且目标里有
            const toReactivate: number[] = [];
            for (const uid of target) {
                const p = existingByUserId.get(uid);
                if (!p) continue;
                if (!isActiveParticipant(p)) toReactivate.push(uid);
            }

            // 要新增的：从未存在过记录
            const toCreate: number[] = [];
            for (const uid of target) {
                if (!existingByUserId.has(uid)) toCreate.push(uid);
            }

            // 1) 失活移除（保留历史记录，避免 unique 冲突）
            if (toDeactivate.length > 0) {
                await tx.orderParticipant.updateMany({
                    where: {dispatchId, userId: {in: toDeactivate}},
                    data: {isActive: false},
                });
            }

            // 2) 恢复参与者：重新加入必须重新“待接单”
            if (toReactivate.length > 0) {
                await tx.orderParticipant.updateMany({
                    where: {dispatchId, userId: {in: toReactivate}},
                    data: {
                        isActive: true,
                        acceptedAt: null,
                        rejectedAt: null,
                        rejectReason: null,
                    } as any,
                });
            }

            // 3) 新增参与者：只对真正不存在的 createMany，并加 skipDuplicates 兜底
            if (toCreate.length > 0) {
                await tx.orderParticipant.createMany({
                    data: toCreate.map((uid) => ({
                        dispatchId,
                        userId: uid,
                        isActive: true,
                    })),
                    skipDuplicates: true,
                });
            }

            // 4) 参与者一旦变化：本轮回到 WAIT_ACCEPT（要求重新确认）
            if (toDeactivate.length > 0 || toReactivate.length > 0 || toCreate.length > 0) {
                await tx.orderDispatch.update({
                    where: {id: dispatchId},
                    data: {
                        status: DispatchStatus.WAIT_ACCEPT,
                        // 可选：记录一次更新时间字段（如果你有）
                        // updatedAt: now,
                    } as any,
                });

                // 同步订单状态（可选：如果你有“已派单/待接单”的订单状态口径）
                // await tx.order.update({ where: { id: dispatch.orderId }, data: { status: OrderStatus.WAIT_ACCEPT } });
            }

            // 5) 记录日志（符合你“关键动作必须记录 UserLog”）
            await this.logOrderAction(operatorId, dispatch.orderId, 'UPDATE_DISPATCH_PARTICIPANTS', {
                dispatchId,
                targetUserIds: target,
                deactivated: toDeactivate,
                reactivated: toReactivate,
                created: toCreate,
                remark: dto?.remark ?? null,
                at: now,
            });
        });

        // 返回最新详情（前端刷新用）
        // 这里用订单详情最稳
        const after = await this.prisma.orderDispatch.findUnique({
            where: {id: dispatchId},
            select: {orderId: true},
        });
        return this.getOrderDetail(Number(after?.orderId));
    }


    async adjustSettlementFinalEarnings(dto: { settlementId: number; finalEarnings: number; remark?: string }, operatorId: number) {
        const settlementId = Number(dto.settlementId);
        const finalEarnings = Number(dto.finalEarnings);

        if (!settlementId) throw new BadRequestException('settlementId 必填');
        if (!Number.isFinite(finalEarnings)) throw new BadRequestException('finalEarnings 非法');

        const s = await this.prisma.orderSettlement.findUnique({
            where: {id: settlementId},
            select: {id: true, orderId: true, calculatedEarnings: true, finalEarnings: true, manualAdjustment: true},
        });
        if (!s) throw new NotFoundException('结算记录不存在');

        const manualAdjustment = finalEarnings - Number(s.calculatedEarnings ?? 0);

        const updated = await this.prisma.orderSettlement.update({
            where: {id: settlementId},
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
            where: {id: orderId},
            include: {
                dispatches: {select: {id: true, status: true}},
                settlements: {select: {id: true, paymentStatus: true, calculatedEarnings: true, finalEarnings: true}},
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
                where: {id: orderId},
                data: {status: OrderStatus.REFUNDED},
            });

            // 2) 当前/历史 dispatch 如果不是终态，可选标记为 COMPLETED（防止继续流转）
            //    这里按“退款即结束”处理：把非 COMPLETED 的 ACCEPTED/WAIT_ACCEPT/WAIT_ASSIGN/ARCHIVED 统一改为 COMPLETED
            await tx.orderDispatch.updateMany({
                where: {
                    orderId,
                    status: {in: [DispatchStatus.WAIT_ASSIGN, DispatchStatus.WAIT_ACCEPT, DispatchStatus.ACCEPTED, DispatchStatus.ARCHIVED]},
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
                        where: {id: s.id},
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
                    where: {id: orderId},
                    data: {
                        totalPlayerEarnings: 0,
                    },
                });
                // ✅ 4) 钱包冲正
                await this.wallet.reverseOrderSettlementEarnings({ orderId }, tx);
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
            where: {id: orderId},
            include: {project: true},
        });
        if (!order) throw new NotFoundException('订单不存在');

        // 未结单才允许编辑
        const forbid = new Set<OrderStatus>([OrderStatus.COMPLETED, OrderStatus.REFUNDED]);
        if (forbid.has(order.status)) throw new ForbiddenException('已结单/已退款订单不允许编辑');

        // 允许编辑的字段（不含陪玩/派单）
        const data: any = {
            orderQuantity: dto.orderQuantity != null ? Number(dto.orderQuantity) : undefined,
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
            const project = await this.prisma.gameProject.findUnique({where: {id: Number(dto.projectId)}});
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
            where: {id: orderId},
            data,
        });

        await this.logOrderAction(operatorId, orderId, 'UPDATE_ORDER', {
            changes: data,
            remark: dto.remark ?? null,
        });

        return this.getOrderDetail(orderId);
    }

    async getMyWorkbenchStats(userId: number) {
        userId = Number(userId);
        if (!userId) throw new ForbiddenException('未登录或无权限操作');

        const now = new Date();

        // ✅ 仍按服务器本地时区切分（后续要统一北京时间再集中处理）
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

        const startMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        const endMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        // ✅ 钱包收益流水口径：只统计“结算收益入账”，并排除已冲正（退款）流水
        // - 这样 Workbench 与钱包列表、解冻统计一致
        const baseWhere: any = {
            userId,
            direction: 'IN',
            bizType: 'SETTLEMENT_EARNING',
            status: { not: 'REVERSED' },
            // 可选：确保有 dispatchId（正常都会有）
            dispatchId: { not: null },
        };

        const whereToday = {
            ...baseWhere,
            createdAt: { gte: startToday, lte: endToday },
        };

        const whereMonth = {
            ...baseWhere,
            createdAt: { gte: startMonth, lte: endMonth },
        };

        // ✅ 今日/月 接单数：按 dispatchId 去重计数
        // Prisma 的 count 不支持 distinct 字段计数时，这里用 findMany + distinct 再 length（数据量小，性能OK）
        const [todayDispatches, monthDispatches] = await Promise.all([
            this.prisma.walletTransaction.findMany({
                where: whereToday,
                select: { dispatchId: true },
                distinct: ['dispatchId'],
            }),
            this.prisma.walletTransaction.findMany({
                where: whereMonth,
                select: { dispatchId: true },
                distinct: ['dispatchId'],
            }),
        ]);

        const todayCount = todayDispatches.length;
        const monthCount = monthDispatches.length;

        // ✅ 今日/月 收益：sum(amount)
        const [todayIncomeAgg, monthIncomeAgg] = await Promise.all([
            this.prisma.walletTransaction.aggregate({
                where: whereToday,
                _sum: { amount: true },
            }),
            this.prisma.walletTransaction.aggregate({
                where: whereMonth,
                _sum: { amount: true },
            }),
        ]);

        const todayIncome = Number(todayIncomeAgg?._sum?.amount ?? 0);
        const monthIncome = Number(monthIncomeAgg?._sum?.amount ?? 0);

        return {
            todayCount,
            todayIncome,
            monthCount,
            monthIncome,
        };
    }

    // ✅ 关键：dispatch 结算互斥抢占
    // - 只能从 ACCEPTED -> SETTLING
    // - 抢占成功：当前请求成为“唯一结算者”
    // - 抢占失败：说明另一个请求已经在处理/处理完成
    async lockDispatchForSettlementOrThrow(dispatchId: number, tx: any) {
        const locked = await tx.orderDispatch.updateMany({
            where: { id: dispatchId, status: DispatchStatus.ACCEPTED },
            data: { status: DispatchStatus.SETTLING },
        });

        if (locked.count === 0) {
            // ✅ 抢占失败：要么已结算/已存单，要么正在处理中
            throw new BadRequestException('该派单正在结算中或已处理，请刷新后重试');
        }

    }



    /**
     * ✅ 金额统一处理：保留 1 位小数（与你原来的 round1 调用对齐）
     * - 避免浮点误差导致的对账问题
     */
    private round1(n: number) {
        const x = Number(n || 0);
        return Math.round(x * 10) / 10;
    }

    /**
     * ✅ 构建“进度比例”映射，用于存单（ARCHIVE）按贡献分摊
     *
     * 规则（保守版）：
     * - progress 取值范围建议 0~1（你如果用 0~100，记得在这里除以 100）
     * - 若所有 progress 都为空/0，则每个参与者按 1 平均
     *
     * 返回：
     * - key: participant.id
     * - value: ratio（0~1）
     */
    private buildProgressRatioMap(participants: Array<{ id: number; progress?: number | null }>) {
        const weightMap = new Map<number, number>();

        // 1) 取权重：progress 有值则用 progress，否则用 1
        for (const p of participants) {
            const raw = p.progress;
            // ✅ 如果 progress 是 0~100（你项目有可能），可改为：const w = raw != null ? raw / 100 : 1;
            const w = raw != null ? Number(raw) : 1;
            weightMap.set(p.id, Math.max(0, w));
        }

        // 2) 归一化
        const total = Array.from(weightMap.values()).reduce((a, b) => a + b, 0);

        // 3) total=0 时兜底平均
        if (!total) {
            const avg = participants.length > 0 ? 1 / participants.length : 0;
            const ratioMap = new Map<number, number>();
            for (const p of participants) ratioMap.set(p.id, avg);
            return ratioMap;
        }

        const ratioMap = new Map<number, number>();
        for (const [id, w] of weightMap.entries()) {
            ratioMap.set(id, w / total);
        }
        return ratioMap;
    }

    /**
     * ✅ 计算单个陪玩理论收益（保守版）
     *
     * 说明：
     * - 你项目真实收益规则可能更复杂（等级/类型/抽成/补收/超时/平台扣点等）
     * - 这里先提供最小实现，让编译通过，并保持“可替换点集中”
     */
    private calcPlayerEarning(params: {
        order: { paidAmount: number };
        participantsCount: number;
        ratio?: number; // ARCHIVE 模式用：按进度比例分摊
    }) {
        const { order, participantsCount, ratio } = params;

        const paid = Number(order?.paidAmount || 0);
        const count = Math.max(1, Number(participantsCount || 1));

        // ✅ 默认：总收益先平均分给所有陪玩（后续你可替换为“陪玩分成比例”）
        const base = paid / count;

        // ✅ ARCHIVE 模式：如果传入 ratio，则按 ratio 分摊（否则仍按平均）
        const r = ratio != null ? Number(ratio) : 1;

        return this.round1(base * r);
    }

    /**
     * ✅ 倍率解析（保守版）
     *
     * 说明：
     * - 你原先代码里有 resolveMultiplier(order, participant)
     * - 如果你有会员等级/陪玩等级/加价倍率，在这里集中实现
     */
    private resolveMultiplier(
        _order: any,
        _participant: any,
    ) {
        return 1;
    }


}
