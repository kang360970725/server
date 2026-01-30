import {BadRequestException, ConflictException, Injectable, NotFoundException} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';
import {CreateOrderDto} from './dto/create-order.dto';
import {QueryOrdersDto} from './dto/query-orders.dto';
import {AcceptDispatchDto} from './dto/accept-dispatch.dto';
import {MarkPaidDto} from './dto/mark-paid.dto';
import {
    BillingMode,
    DispatchStatus,
    OrderStatus,
    OrderType,
    PaymentStatus,
    PlayerWorkStatus,
    WalletBizType
} from '@prisma/client';
import {WalletService} from '../wallet/wallet.service';
import {randomUUID, randomInt} from 'crypto';
import {groupByUserId, round2, roundMix1, toNum} from "../utils/money/format";
import {
    computeBillingGuaranteed,
    computeBillingHours,
    computeBillingMODEPLAY
} from "../utils/orderDispatches/revenueInit";
import {compareSettlementsToPlan} from "../utils/finance/generateRepairPlan";
import {computeSettlementFreezeTime} from "../utils/orderDispatches/settlement-freeze.rule";

@Injectable()
export class OrdersService {
    constructor(
        private prisma: PrismaService,
        private wallet: WalletService,
    ) {
    }

    private readonly settlementRepairCache = new Map<number, any[]>();

    /*** -----------------------------
     * 创建订单方法
     * -----------------------------*/
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
        const isPaid = dto.isGifted ? false : Boolean(dto.isPaid);

        const order = await this.prisma.order.create({
            data: {
                orderQuantity: Number(dto.orderQuantity ?? 1),
                autoSerial: serial,
                // receivableAmount: dto.receivableAmount,
                // paidAmount: dto.paidAmount,
                // paymentTime: dto.paymentTime ? new Date(dto.paymentTime) : null,

                // ✅ 赠送单不可强制清零金额，清零后结算会产生错误
                receivableAmount: dto.receivableAmount,
                paidAmount: dto.paidAmount,

                // ✅ 赠送单一般不应有付款时间（也可以按业务改成 now）
                paymentTime: isGifted || isPaid ? null : (dto.paymentTime ? new Date(dto.paymentTime) : null),
                isPaid,

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
            // 复用现有派单逻辑（包含防重复、参与者写入、日志等）
            await this.assignDispatch(order.id, playerIds, dispatcherId, 'AUTO_CREATE');
            // 派单后返回完整详情（带 currentDispatch/participants）
            return this.getOrderDetail(order.id);
        }

        // 未选择打手：保持 WAIT_ASSIGN
        return this.getOrderDetail(order.id);
    }

    /*** -----------------------------
     * 订单列表获取
     * -----------------------------*/
    async listOrders(query: any) {
        const page = query.page ?? 1;
        const limit = query.limit ?? 10;
        const skip = (page - 1) * limit;

        const where: any = {};

        // 你原来的精确/单字段筛选保留
        if (query.serial) where.autoSerial = { contains: query.serial };
        if (query.projectId) where.projectId = query.projectId;
        if (query.status) where.status = query.status as any;
        if (query.dispatcherId) where.dispatcherId = query.dispatcherId;
        if (query.customerGameId) where.customerGameId = { contains: query.customerGameId };
        if (query.playerId) {
            where.dispatches = {
                some: { participants: { some: { userId: query.playerId } } },
            };
        }
        if (query.isPaid !== undefined) where.isPaid = Boolean(query.isPaid);

        // ✅ 全局 keyword：订单号 / 客服 / 陪玩昵称
        const keyword = query.keyword?.trim();
        if (keyword) {
            where.OR = [
                // 1) 订单号
                { autoSerial: { contains: keyword } },

                // 2) 客服（dispatcher）
                { dispatcher: { name: { contains: keyword } } },

                // 3) 陪玩昵称（任意历史/当前派单参与者）
                {
                    dispatches: {
                        some: {
                            participants: {
                                some: {
                                    user: { name: { contains: keyword } },
                                },
                            },
                        },
                    },
                },
            ];
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

        return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
    }


    /*** -----------------------------
     * 订单详情方法
     * -----------------------------*/
    /*** -----------------------------
     * 订单详情（含钱包真实收益 & 对账提示）
     * -----------------------------*/
    async getOrderDetail(id: number) {
        // ===========================
        // 1️⃣ 查询订单 + 结算（参考）
        // ===========================
        const order = await this.prisma.order.findUnique({
            where: {id},
            include: {
                project: true,
                dispatcher: {
                    select: {id: true, name: true, phone: true},
                },

                // ✅ 当前派单批次
                currentDispatch: {
                    include: {
                        participants: {
                            where: {isActive: true},
                            include: {
                                user: {
                                    select: {
                                        id: true,
                                        name: true,
                                        phone: true,
                                        workStatus: true,
                                    },
                                },
                            },
                            orderBy: {id: 'asc'},
                        },
                    },
                },

                // ✅ 历史派单批次
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

                // ✅ 结算明细（参考口径）
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

        // ===========================
        // 2️⃣ 查询钱包真实流水（唯一资金事实）
        // ===========================
        const walletTxs = await this.prisma.walletTransaction.findMany({
            where: {
                orderId: id,
                status: {not: 'REVERSED'}, // ❗ 冲正不参与统计
            },
            select: {
                userId: true,
                amount: true,
                direction: true, // ✅ 必须
                status: true, // FROZEN / AVAILABLE
                bizType: true,
                // ✅ 直接把用户基础信息带出来
                user: {
                    select: {
                        id: true,
                        name: true,
                        phone: true, // 可选，Detail 里很多地方会用到
                    },
                },
            },
        });

        // ===========================
        // 3️⃣ 钱包收益汇总（真实）- ✅区分 IN / OUT
        // ===========================
        let inTotal = 0;     // IN 合计（正数展示）
        let outTotal = 0;    // OUT 合计（正数展示）
        let netTotal = 0;    // 净额（IN - OUT）

        let frozenNet = 0;   // 冻结净额
        let availableNet = 0; // 可用净额

        for (const tx of walletTxs) {
            const amt = Number(tx.amount || 0);
            const isOut = tx.direction === 'OUT';
            const signed = isOut ? -amt : amt;

            if (isOut) outTotal += amt;
            else inTotal += amt;

            netTotal += signed;

            if (tx.status === 'FROZEN') frozenNet += signed;
            if (tx.status === 'AVAILABLE') availableNet += signed;
        }

        // 兼容旧变量名：walletTotal = 净额
        const walletTotal = Number(netTotal.toFixed(2));
        const frozen = Number(frozenNet.toFixed(2));
        const available = Number(availableNet.toFixed(2));

        // ===========================
        // 4️⃣ 结算参考汇总
        // ===========================
        const settlementTotal = order.settlements.reduce(
            (sum, s) => sum + Number(s.finalEarnings || 0),
            0,
        );

        // ===========================
        // 5️⃣ 对账提示（只读）- ✅用净额对账
        // ===========================
        const diff = Number((walletTotal - settlementTotal).toFixed(2));

        let reconcileStatus: 'MATCHED' | 'MISMATCHED' | 'EMPTY';

        if (!order.settlements.length && walletTotal === 0 && inTotal === 0 && outTotal === 0) {
            reconcileStatus = 'EMPTY';
        } else if (diff === 0) {
            reconcileStatus = 'MATCHED';
        } else {
            reconcileStatus = 'MISMATCHED';
        }

        // ===========================
        // ✅ 4.1 结算按人汇总（参考）
        // ===========================
        const settlementByUser = new Map<number, number>();
        for (const s of order.settlements || []) {
            const uid = Number(s?.userId || 0);
            if (!uid) continue;
            const v = Number(s?.finalEarnings || 0);
            settlementByUser.set(uid, (settlementByUser.get(uid) || 0) + v);
        }
        const userMap = new Map<number, { id: number; name: string; phone?: string }>();
        for (const tx of walletTxs) {
            if (tx.user) {
                userMap.set(tx.user.id, tx.user);
            }
        }

        // ===========================
        // ✅ 4.2 钱包按人汇总（真实）- ✅区分 IN/OUT/净额
        // ===========================
        const walletNetByUser = new Map<number, number>();
        const walletInByUser = new Map<number, number>();
        const walletOutByUser = new Map<number, number>();

        for (const tx of walletTxs) {
            const uid = Number(tx?.userId || 0);
            if (!uid) continue;

            const amt = Number(tx?.amount || 0);
            const isOut = tx.direction === 'OUT';
            const signed = isOut ? -amt : amt;

            walletNetByUser.set(uid, (walletNetByUser.get(uid) || 0) + signed);

            if (isOut) walletOutByUser.set(uid, (walletOutByUser.get(uid) || 0) + amt);
            else walletInByUser.set(uid, (walletInByUser.get(uid) || 0) + amt);
        }

        // ===========================
        // ✅ 4.3 合并成“按人对账结果”
        // - 规则：diff = walletNet - settlement
        // ===========================
        const userIds = new Set<number>([
            ...Array.from(settlementByUser.keys()),
            ...Array.from(walletNetByUser.keys()),
        ]);

        const reconcileHintByUser = Array.from(userIds)
            .map((userId) => {
                const settlementTotal = Number((settlementByUser.get(userId) || 0).toFixed(2));

                const walletNet = Number((walletNetByUser.get(userId) || 0).toFixed(2));
                const walletIn = Number((walletInByUser.get(userId) || 0).toFixed(2));
                const walletOut = Number((walletOutByUser.get(userId) || 0).toFixed(2));

                const diff = Number((walletNet - settlementTotal).toFixed(2));

                let status: 'MATCHED' | 'MISMATCHED' | 'EMPTY' = 'MISMATCHED';
                if (settlementTotal === 0 && walletNet === 0 && walletIn === 0 && walletOut === 0) status = 'EMPTY';
                else if (diff === 0) status = 'MATCHED';
                const user = userMap.get(userId);
                // 兼容旧字段 walletTotal（净额），并额外返回 IN/OUT/净额
                return {
                    userId,
                    settlementTotal,
                    userName: user?.name || `#${userId}`,
                    walletTotal: walletNet, // ✅ 兼容旧字段名（语义：净额）
                    walletNet,
                    walletIn,
                    walletOut,
                    diff,
                    status,
                };
            })
            .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

        // ===========================
        // 6️⃣ 返回
        // ===========================
        return {
            ...order,

            // ✅ 钱包真实收益概览（增强：IN/OUT/净额）
            walletEarningsSummary: {
                // 兼容旧字段：total/frozen/available（现在表示净额口径）
                total: walletTotal,
                frozen,
                available,

                // 新增：客服友好展示
                inTotal: Number(inTotal.toFixed(2)),
                outTotal: Number(outTotal.toFixed(2)),
                netTotal: walletTotal,
            },

            // ✅ 对账提示（用于 UI / 后续修复入口）
            reconcileHint: {
                status: reconcileStatus,
                settlementTotal,
                walletTotal, // ✅ 净额
                diff,        // ✅ 净额 - 结算
            },

            reconcileHintByUser,
        };

    }

    /*** -----------------------------
     * 取消订单方法
     * -----------------------------*/
    async cancelOrder(orderId: number, operatorId: number, remark?: string) {
        if (!orderId) throw new BadRequestException('orderId 必填');

        const order = await this.prisma.order.findUnique({
            where: {id: orderId},
            select: {id: true, status: true},
        });

        if (!order) throw new NotFoundException('订单不存在');

        const forbidden = new Set(['COMPLETED', 'REFUNDED']);
        if (forbidden.has(String(order.status))) {
            throw new BadRequestException('当前订单状态不可取消');
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

    /*** -----------------------------
     * 派单 / 重新派单（创建新的派单批次）
     *  ARCHIVED 状态也允许再次派单；派单后状态流转与新建订单一致（WAIT_ACCEPT）
     * -----------------------------*/
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
                    throw new BadRequestException('当前订单存在未完成派单（待接单/已接单），禁止重复派单');
                }
            }
        }

        // ✅ v0.1：允许 WAIT_ASSIGN / ARCHIVED 派单
        // - ARCHIVED：存单后仍保持存单态，但允许创建新 dispatch（round+1），并把 currentDispatch 指向新批次
        const allowOrderStatus = new Set(['WAIT_ASSIGN', 'ARCHIVED']);
        if (!allowOrderStatus.has(String(order.status))) {
            throw new BadRequestException('当前订单状态不可派单');
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

    /*** -----------------------------
     * 打手存单/结单（ARCHIVED）——本轮只需正常存单
     * -----------------------------*/
    async archiveDispatch(dispatchStatus: DispatchStatus, dispatchId: number, user: any, dto: any) {
        const operatorId: number = user.userId
        const orderId = await this.prisma.$transaction(async (tx) => {
            await this.lockDispatchForSettlementOrThrow(dispatchId, tx);
            try {
                const dispatch = await tx.orderDispatch.findUnique({
                    where: {id: dispatchId},
                    include: {
                        order: {include: {project: true}},
                        participants: true,
                    },
                });
                if (!dispatch) throw new BadRequestException('派单批次不存在');

                // ✅ 1) 权限校验：必须是参与者（最小实现：只允许参与者存单）
                const isParticipant = dispatch.participants?.some((p) => p.userId === operatorId);
                if (!isParticipant) throw new BadRequestException('你不是本轮派单参与者，无权操作');

                // ✅ 2) 防重复（可选但建议）
                if (dispatch.status === dispatchStatus) {
                    throw new BadRequestException(`该派单已${dispatchStatus === 'ARCHIVED' ? '存' : '结'}单，无需重复操作`);
                }

                const snap = dispatch?.order?.projectSnapshot as any;
                const orderClass: string | null =
                    dispatch.order?.project?.billingMode ??
                    (snap && typeof snap === 'object' && !Array.isArray(snap) ? (snap.billingMode ?? null) : null);
                if (!orderClass) throw new BadRequestException('订单类型有误，无法操作，请联系管理员！');

                // HOURLY: 小时单
                // GUARANTEED: 保底单
                // MODE_PLAY: 玩法单

                // ✅ 3) 按单型写入“本次存单口径数据”
                // if (orderClass === 'HOURLY') {}
                if (orderClass === 'GUARANTEED') {
                    const progresses = dto.progresses ?? [];
                    for (const p of progresses) {
                        const userId = Number(p?.userId);
                        if (!Number.isFinite(userId) || userId <= 0) continue;

                        await tx.orderParticipant.updateMany({
                            where: {
                                dispatchId,
                                userId,
                                isActive: true, // ✅ 修正：更新当前活跃参与者
                            },
                            data: {
                                progressBaseWan: roundMix1(p?.progressBaseWan),
                                isActive: false, // ✅ 同时置失效
                            },
                        });
                    }
                } else { //小时单 玩法单，直接置为存/结单。更新状态
                    const progresses = dto.progresses ?? [];
                    for (const p of progresses) {
                        const userId = Number(p?.userId);
                        if (!Number.isFinite(userId) || userId <= 0) continue;

                        await tx.orderParticipant.updateMany({
                            where: {
                                dispatchId,
                                userId,
                                isActive: true, // ✅ 修正：更新当前活跃参与者
                            },
                            data: {
                                isActive: false, // ✅ 同时置失效
                            },
                        });
                    }
                }

                const now = new Date();

                // ✅ 4) 派单置存/结单
                await tx.orderDispatch.update({
                    where: {id: dispatchId},
                    data: {
                        status: dispatchStatus,
                        archivedAt: now,
                        completedAt: dispatchStatus === 'COMPLETED' ? now : null,
                        remark: dto.remark ?? dispatch.remark ?? null,
                        ...(orderClass === 'HOURLY'
                            ? {
                                deductMinutesValue:
                                    dto.deductMinutesValue === undefined || dto.deductMinutesValue === null
                                        ? null
                                        : Math.max(0, Math.floor(Number(dto.deductMinutesValue))),

                                billableMinutes:
                                    dto.billableMinutes === undefined || dto.billableMinutes === null
                                        ? null
                                        : Math.max(0, Math.floor(Number(dto.billableMinutes))),

                                billableHours:
                                    dto.billableHours === undefined || dto.billableHours === null
                                        ? null
                                        : Number(dto.billableHours),
                            }
                            : {}),
                    },
                });
                // ✅ 5) 订单置存单
                await tx.order.update({
                    where: {id: dispatch.orderId},
                    data: {status: dispatchStatus === 'COMPLETED' ? OrderStatus.COMPLETED_PENDING_CONFIRM : OrderStatus.ARCHIVED},
                });

                // ⚠️ 6) 释放参与者状态：这是运营副作用，你现在保留也行
                // 但更严谨是仅释放本轮参与者（你现在就是 participants）
                const userIds = dispatch.participants.map((p) => p.userId);
                await tx.user.updateMany({
                    where: {id: {in: userIds}},
                    data: {workStatus: 'IDLE' as any},
                });
                // ✅ 7) 写日志：记录“谁、什么时候、存的什么”
                await this.logOrderAction(
                    operatorId,
                    dispatch.orderId,
                    'ARCHIVE_DISPATCH',
                    {
                        dispatchId,
                        archivedAt: now.toISOString(),
                        orderClass,
                        remark: dto.remark ?? null,
                        // 保底单关键数据：把前端传入的 progresses 原样记录（或记录 normalize 后也行）
                        progresses: orderClass === 'GUARANTEED' ? (dto.progresses ?? []) : undefined,
                        // 小时单关键数据：你算出来的 minutes/hours 也建议塞这里（你现在还没接上）
                    },
                    tx,
                    `用户(${user.name})进行${dispatchStatus === 'ARCHIVED' ? '存' : '结'}单操作`,
                );
                return dispatch.orderId;
            } catch (e) {
                // ✅ 失败释放锁：仅当还处于 SETTLING 才回滚
                await tx.orderDispatch.updateMany({
                    where: {id: dispatchId, status: DispatchStatus.SETTLING},
                    data: {status: DispatchStatus.ACCEPTED},
                });

                // ✅ 关键：必须 rethrow，保证事务整体回滚
                throw e;
            }
        }, {maxWait: 5000, timeout: 20000});

        return {
            code: 200,
            msg: `${dispatchStatus === 'ARCHIVED' ? '存' : '结'}单成功`,
            orderId
        };
    }

    /*** -----------------------------
     * 小时单补收（只修改收款口径，不触发结算重算）。
     * ✅ 仅“已结单待确认”阶段允许补收（OrderStatus.COMPLETED_PENDING_CONFIRM）
     * ✅ 仅小时单（BillingMode.HOURLY）
     * ✅ 实付金额仅允许增加（超时补收），不允许减少
     *
     * 兼容：先打后付的收款逻辑
     * - 如果订单当前未付款（isPaid=false），补收时默认一并标记已付款（isPaid=true、paymentTime=now）
     * - 前端可传 confirmPaid=false 显式取消（checkbox 取消勾选）
     * - 已付款订单不覆盖 paymentTime，避免历史付款时间被误改
     * - 允许 body 传 string/boolean，内部统一转 boolean
     **/
    async updatePaidAmount(orderId: number, paidAmount: number, operatorId: number, remark?: string, confirmPaid?: any,) {
        if (!orderId) throw new BadRequestException('id 必填');
        if (!Number.isFinite(paidAmount) || paidAmount < 0) throw new BadRequestException('paidAmount 非法');

        return this.prisma.$transaction(async (tx) => {
            // 1) 读取订单（事务内）
            const order = await tx.order.findUnique({
                where: {id: orderId},
                include: {project: true},
            });
            if (!order) throw new NotFoundException('订单不存在');


            await this.assertOrderNotSettlingOrThrow(tx, orderId, '订单正在结算处理中，请稍后再试');

            await this.applyPaidAmountUpdateInTx(tx, order, paidAmount, operatorId, remark, confirmPaid);

            // ✅ 不重算、不动钱包
            return tx.order.findUnique({where: {id: orderId}});
        });
    }

    /*** -----------------------------
     * 更新参与者；前端目前是存单模式下调用 todo 1-24 需优化，同派单方法一致即可
     * --------------------------*/
    async updateDispatchParticipants(
        dto: { dispatchId: number; playerIds: number[]; remark?: string },
        operatorId: number,
    ) {
        const dispatchId = Number(dto?.dispatchId);
        operatorId = Number(operatorId);

        if (!dispatchId) throw new BadRequestException('dispatchId 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');

        const targetUserIds = Array.isArray(dto?.playerIds)
            ? dto.playerIds.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n))
            : [];

        if (targetUserIds.length <= 0) {
            throw new BadRequestException('参与者不能为空');
        }

        const target = Array.from(new Set<number>(targetUserIds));
        const now = new Date();

        let finalDispatchId = dispatchId;
        let finalOrderId: number | null = null;

        await this.prisma.$transaction(async (tx) => {
            const dispatch = await tx.orderDispatch.findUnique({
                where: {id: dispatchId},
                include: {
                    order: {select: {id: true, status: true}},
                    participants: true,
                },
            });

            if (!dispatch) throw new NotFoundException('派单批次不存在');

            finalOrderId = Number(dispatch.orderId);

            // 锁轮判断：已不是 WAIT_ACCEPT / 有人接单 / 有人拒单（含 rejectedAt） => 必须新建一轮
            const hasAccepted = dispatch.participants.some((p: any) => !!p.acceptedAt);
            const hasRejected = dispatch.participants.some((p: any) => !!p.rejectedAt);

            const shouldCreateNewRound =
                dispatch.status !== DispatchStatus.WAIT_ACCEPT || hasAccepted || hasRejected;

            if (shouldCreateNewRound) {
                // 1) 旧轮次不再是 latest（如果你确实有 isLatest 字段）
                //    注意：如果你没有 isLatest 字段，请删除这一段
                try {
                    await tx.orderDispatch.update({
                        where: {id: dispatchId},
                        data: {isLatest: false} as any,
                    });
                } catch (e) {
                    // 如果 schema 没有 isLatest，避免事务直接炸（你可以删掉 try/catch 改为显式字段）
                }

                // 2) 新建一轮派单（⚠️ 若 OrderDispatch 有必填字段，请在这里补齐）
                const newDispatch = await tx.orderDispatch.create({
                    data: {
                        orderId: dispatch.orderId,
                        status: DispatchStatus.WAIT_ACCEPT,
                        isLatest: true,
                        // ⚠️ TODO: 如果你的 OrderDispatch 还有必填字段（如 round/batchNo/dispatcherId/createdBy 等），请在这里补上
                        // round: (dispatch.round ?? 0) + 1,
                        // operatorId,
                        // remark: dto?.remark ?? null,
                    } as any,
                });

                finalDispatchId = Number(newDispatch.id);

                // 3) 给新轮次写入参与者
                await tx.orderParticipant.createMany({
                    data: target.map((uid) => ({
                        dispatchId: newDispatch.id,
                        userId: uid,
                        isActive: true,
                    })),
                    skipDuplicates: true,
                });

                // 4) 记录日志
                await this.logOrderAction(operatorId, dispatch.orderId, 'CREATE_NEW_DISPATCH_AND_SET_PARTICIPANTS', {
                    fromDispatchId: dispatchId,
                    toDispatchId: newDispatch.id,
                    targetUserIds: target,
                    reason: {
                        status: dispatch.status,
                        hasAccepted,
                        hasRejected,
                    },
                    remark: dto?.remark ?? null,
                    at: now,
                });

                return;
            }

            // ✅ 否则：仍在 WAIT_ACCEPT 且无人接单/拒单 —— 允许在本轮“整体覆盖”
            await tx.orderParticipant.updateMany({
                where: {dispatchId},
                data: {isActive: false},
            });

            await tx.orderParticipant.createMany({
                data: target.map((uid) => ({
                    dispatchId,
                    userId: uid,
                    isActive: true,
                })),
                skipDuplicates: true,
            });

            await this.logOrderAction(operatorId, dispatch.orderId, 'UPDATE_DISPATCH_PARTICIPANTS', {
                dispatchId,
                targetUserIds: target,
                remark: dto?.remark ?? null,
                at: now,
            });
        });

        // 返回订单详情，供前端刷新
        if (!finalOrderId) {
            const after = await this.prisma.orderDispatch.findUnique({
                where: {id: finalDispatchId},
                select: {orderId: true},
            });
            finalOrderId = Number(after?.orderId);
        }

        return this.getOrderDetail(Number(finalOrderId));
    }

    /*** -----------------------------
     * 结算手动调整（管理端/财务） todo 1-24 即将废弃，前提是需上线重新结算，且不允许所有订单类型可手动调整
     * --------------------------*/
    async adjustSettlementFinalEarnings(dto: { settlementId: number; finalEarnings: number; remark?: string }, operatorId: number,) {
        const settlementId = Number(dto.settlementId);
        const finalEarnings = Number(dto.finalEarnings);

        if (!settlementId) throw new BadRequestException('settlementId 必填');
        if (!Number.isFinite(finalEarnings)) throw new BadRequestException('finalEarnings 非法');

        return this.prisma.$transaction(async (tx) => {
            const s = await tx.orderSettlement.findUnique({
                where: {id: settlementId},
                select: {
                    id: true,
                    orderId: true,
                    dispatchId: true,
                    userId: true,
                    settlementType: true,
                    calculatedEarnings: true,
                    finalEarnings: true,
                    manualAdjustment: true,
                },
            });
            if (!s) throw new NotFoundException('结算记录不存在');

            // ===========================
            // ✅ 校验：已解冻/不冻结则禁止调整
            // ===========================
            const earningTx = await tx.walletTransaction.findUnique({
                where: {
                    sourceType_sourceId: {
                        sourceType: 'ORDER_SETTLEMENT',
                        sourceId: settlementId,
                    },
                },
                select: {id: true, status: true},
            });

            // 兼容历史：如果没有 walletTx（老数据），允许调整（并会在同步方法里补建）
            if (earningTx) {
                if (earningTx.status !== 'FROZEN') {
                    throw new BadRequestException('该结算已解冻/已入账，禁止手动调整');
                }

                const hold = await tx.walletHold.findUnique({
                    where: {earningTxId: earningTx.id},
                    select: {status: true},
                });

                // 若 hold 存在且不是 FROZEN，也视为已解冻/不可调整
                if (hold && hold.status !== 'FROZEN') {
                    throw new BadRequestException('该结算已解冻/已入账，禁止手动调整');
                }
            }

            // ===========================
            // 1) 更新结算记录
            // ===========================
            const calculated = Number(s.calculatedEarnings ?? 0);
            const manualAdjustment = finalEarnings - calculated;

            const updated = await tx.orderSettlement.update({
                where: {id: settlementId},
                data: {
                    finalEarnings,
                    manualAdjustment,

                    // 如果你 schema 里有这些字段就保留；没有就删掉
                    adjustedBy: operatorId,
                    adjustedAt: new Date(),
                    adjustRemark: dto.remark ? `MANUAL_ADJUST:${dto.remark}` : 'MANUAL_ADJUST',
                } as any,
            });

            // ===========================
            // 2) 同步钱包（关键）
            // ✅ 正数：冻结
            // ✅ 负数：即时扣款（availableBalance 立即变化）
            // ✅ 0：释放冻结并不影响余额
            // ===========================
            // 解冻时间：手工调整不应改变 unlockAt
            // - 若已有 hold，用原 unlockAt
            // - 若无 hold 且 final>0，需要一个 unlockAt（这里用 now，满足“先满足需求”）
            let unlockAt = new Date();
            if (earningTx?.id) {
                const hold = await tx.walletHold.findUnique({
                    where: {earningTxId: earningTx.id},
                    select: {unlockAt: true},
                });
                if (hold?.unlockAt) unlockAt = hold.unlockAt;
            }

            await this.wallet.syncSettlementEarningByFinalEarnings(
                {
                    userId: s.userId,
                    finalEarnings,
                    unlockAt,
                    sourceType: 'ORDER_SETTLEMENT',
                    sourceId: settlementId,
                    orderId: s.orderId,
                    dispatchId: s.dispatchId ?? null,
                    settlementId: settlementId,
                },
                tx as any,
            );

            // ✅ 日志
            await this.logOrderAction(operatorId, s.orderId, 'ADJUST_SETTLEMENT', {
                settlementId,
                targetUserId: s.userId,
                settlementType: s.settlementType,
                oldFinalEarnings: s.finalEarnings,
                newFinalEarnings: finalEarnings,
                manualAdjustment,
                remark: dto.remark ?? null,
            });

            return updated;
        });
    }

    /*** -----------------------------
     * * ✅ 客服最终确认结单
     * * - controller 入口需要：confirmCompleteOrder(orderId, operatorId)
     * * - 幂等：已 COMPLETED 直接返回
     * * - 仅允许：COMPLETED_PENDING_CONFIRM -> COMPLETED
     * * - 并非必须收款，赠送单无法确认收款。
     * --------------------------*/
    async confirmCompleteOrderCopy(orderId: number, operatorId: number, dto?: {
        remark?: string; paidAmount?: number; // ✅ 可选：最终实付（若 > 原实付则视为补收）
        confirmPaid?: any; // ✅ 可选：默认 true（补收=钱已收）
    })
    {
        orderId = Number(orderId);
        operatorId = Number(operatorId);
        if (!orderId) throw new BadRequestException('orderId 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');
        const remark = dto?.remark;
        return this.prisma.$transaction(async (tx) => {
            // 1) 读取订单（带 project，便于 billingMode 读取）
            const order = await tx.order.findUnique({where: {id: orderId}, include: {project: true},});
            if (!order) throw new NotFoundException('订单不存在');
            // 2) 幂等：已最终结单
            if (order.status === OrderStatus.COMPLETED) {
                return {
                    id: order.id,
                    status: order.status,
                    isPaid: (order as any).isPaid ?? false,
                    paidAmount: Number((order as any).paidAmount ?? 0),
                };
            }
            // 3) 必须处于“已结单待确认”（方案2/更规范）
            const PENDING: any = (OrderStatus as any).COMPLETED_PENDING_CONFIRM;
            if (!PENDING) {
                throw new BadRequestException('当前系统未启用“已结单待确认”状态，无法确认结单');
            }
            if (order.status !== PENDING) {
                throw new BadRequestException('仅“已结单待确认”阶段允许确认结单');
            }
            // 4) 并发保护：结算中禁止确认
            await this.assertOrderNotSettlingOrThrow(tx, orderId, '订单正在结算处理中，禁止确认结单');
            // 5) ✅ 允许在确认结单弹窗里录“补收”（小时单）
            // 规则：只有当 dto.paidAmount > 原 paidAmount 时才视为补收
            // 注意：补收逻辑复用 tx 内 helper，避免嵌套 transaction
            const newPaidAmount = dto?.paidAmount === undefined || dto?.paidAmount === null ? undefined : Number(dto.paidAmount);
            if (newPaidAmount !== undefined) {
                // 仅小时单允许补收（若你未来要扩展到其它单型，这里放开并改 helper 校验即可）
                const billingMode: BillingMode | undefined = this.getBillingModeFromOrder(order);
                if (billingMode !== BillingMode.HOURLY) {
                    throw new BadRequestException('仅小时单允许在确认结单时录入补收实付金额');
                }
                const oldPaid = Number((order as any).paidAmount ?? 0);
                if (!Number.isFinite(newPaidAmount) || newPaidAmount < 0) {
                    throw new BadRequestException('paidAmount 非法');
                }
                if (newPaidAmount > oldPaid) {
                    await this.applyPaidAmountUpdateInTx(tx, order, newPaidAmount, operatorId, remark, dto?.confirmPaid,);
                } else if (newPaidAmount < oldPaid) {
                    // 方案B：确认结单入口不允许减少实付（避免口径被破坏）
                    throw new BadRequestException('确认结单时实付金额仅允许不变或增加（补收），不允许减少');
                }
                // 等于 oldPaid：允许，等价于不补收
            }
            // 6) 必须已收款（补收时 confirmPaid 默认 true 会顺带把 isPaid 标记上）
            const orderAfterPaid = await tx.order.findUnique({
                where: {id: orderId},
                select: {id: true, isPaid: true, paidAmount: true, paymentTime: true},
            });
            if (!orderAfterPaid) throw new NotFoundException('订单不存在');
            if ((orderAfterPaid as any).isPaid !== true) {
                throw new BadRequestException('未收款订单不允许最终确认结单');
            }
            // 7) ✅ 按最新 paidAmount 重算 settlement（不入钱包）
            // - 解决你提到的：补收后贡献占比/客服提成未更新、小时单双护被除两次等问题都应在重算逻辑里修
            const settlementBatchId = randomUUID();
            const dispatches = await tx.orderDispatch.findMany({
                where: {
                    orderId,
                    status: {in: [DispatchStatus.COMPLETED as any, DispatchStatus.ARCHIVED as any]},
                }, select: {id: true, status: true}, orderBy: {id: 'asc'},
            });
            // 没有 dispatch 也允许确认？这里按严谨：没有可重算批次就报错
            if (!dispatches || dispatches.length < 1) {
                throw new BadRequestException('未找到可重算的派单批次，无法确认结单');
            }
            // for (const d of dispatches) {
            //     const mode: 'ARCHIVE' | 'COMPLETE' = (d as any).status === (DispatchStatus as any).ARCHIVED ? 'ARCHIVE' : 'COMPLETE';
            //     await this.createSettlementsForDispatch({
            //         orderId, dispatchId: d.id, mode, settlementBatchId,
            //         // ✅ 关键：此处只重算 settlement，不做钱包落账
            //         allowWalletSync: false,
            //     } as any, tx,);
            // }

            for (const d of dispatches) {
                const mode: 'ARCHIVE' | 'COMPLETE' =
                    (d as any).status === (DispatchStatus as any).ARCHIVED ? 'ARCHIVE' : 'COMPLETE';

                // ✅ 强制覆盖：先清掉该轮旧 settlement（避免 skipDuplicates/已存在直接跳过）
                await tx.orderSettlement.deleteMany({
                    where: {orderId, dispatchId: d.id},
                });

                await this.createSettlementsForDispatch(
                    {
                        orderId,
                        dispatchId: d.id,
                        mode,
                        settlementBatchId,
                        allowWalletSync: false, // ✅ 只重算 settlement，不入钱包
                    } as any,
                    tx,
                );
            }
            // 8) ✅ 置为最终 COMPLETED
            const updated = await tx.order.update({
                where: {id: orderId},
                data: {status: OrderStatus.COMPLETED},
                select: {id: true, status: true, isPaid: true, paidAmount: true},
            });
            // 9) ✅ 钱包对齐：以 settlement.finalEarnings 为准补建/修复冻结流水
            // 注意：你现在 wallet.service 报 direction/accountId 字段问题，需要你先把 walletTransaction schema 对齐好；
            // 但这一步是“确认结单必须做”的核心动作之一。
            const settlements = await tx.orderSettlement.findMany({
                where: {orderId},
                select: {id: true, userId: true, dispatchId: true, finalEarnings: true, calculatedEarnings: true,},
                orderBy: [{dispatchId: 'asc'}, {id: 'asc'}],
            });
            for (const s of settlements) {
                const expected = Number(s.finalEarnings ?? s.calculatedEarnings ?? 0);
                if (!Number.isFinite(expected) || expected <= 0) continue;
                await this.wallet.repairSettlementEarning({
                    userId: s.userId,
                    expectedAmount: expected,
                    sourceType: 'ORDER_SETTLEMENT',
                    sourceId: s.id,
                    orderId,
                    dispatchId: s.dispatchId ?? null,
                    settlementId: s.id,
                } as any, tx,);
            }
            // 10) 日志
            await this.writeUserLog(tx, {
                userId: operatorId,
                action: 'CONFIRM_COMPLETE_ORDER',
                targetType: 'ORDER',
                targetId: orderId,
                oldData: {
                    status: order.status,
                    isPaid: (order as any).isPaid ?? false,
                    paidAmount: Number((order as any).paidAmount ?? 0),
                } as any,
                newData: {
                    status: updated.status,
                    isPaid: updated.isPaid,
                    paidAmount: Number(updated.paidAmount ?? 0),
                } as any,
                remark: remark || '客服确认最终结单（含补收/重算/钱包对齐）',
            });
            return updated;
        });
    }

    async confirmCompleteOrder(orderId: number, operatorId: number, dto?: {
        remark?: string; paidAmount?: number; // ✅ 可选：最终实付（若 > 原实付则视为补收）
        confirmPaid?: any; // ✅ 可选：默认 true（补收=钱已收）
        modePlayAllocList?: any //趣味玩法单 客服设定的每轮收益
    })
    {
        orderId = Number(orderId);
        operatorId = Number(operatorId);
        if (!orderId) throw new BadRequestException('orderId 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');
        const remark = dto?.remark;
        // 0) 并发保护：结算中禁止确认
        return this.prisma.$transaction(async (tx) => {
            await this.assertOrderNotSettlingOrThrow(tx, orderId, '订单正在结算处理中，禁止确认结单');
            // 1) 读取订单（带 project，便于 billingMode 读取）
            const inStatuses = [DispatchStatus.COMPLETED as any, DispatchStatus.ARCHIVED as any];
            const dispatchWhere = {status: {in: inStatuses}};
            const order = await tx.order.findUnique({
                where: {id: orderId},
                select: {
                    id: true,
                    paidAmount: true,
                    projectSnapshot: true,
                    status: true,
                    orderQuantity: true,
                    baseAmountWan: true,
                    customClubRate: true,
                    receivableAmount: true,
                    dispatcherId: true,
                    dispatcher: {select: {name: true, userType: true}},
                    dispatches: {
                        ...(dispatchWhere ? {where: dispatchWhere} : {}),
                        select: {
                            id: true,
                            round: true,
                            status: true,
                            acceptedAllAt: true,
                            archivedAt: true,
                            completedAt: true,
                            deductMinutesValue: true,
                            billableHours: true,
                            participants: {
                                select: {
                                    userId: true,
                                    isActive: true,
                                    acceptedAt: true,
                                    progressBaseWan: true,
                                    user: {
                                        select: {name: true, staffRating: {select: {rate: true}}},
                                    },
                                },
                            },
                        },
                    },
                    settlements: {
                        where: {orderId},
                        select: {
                            id: true,
                            dispatchId: true,
                            userId: true,
                            user: {select: {name: true, id: true}},
                            settlementType: true, // 结算类型： EXPERIENCE：体验/福袋（每 3 天批次结算） REGULAR：正价（按月批次结算）
                            calculatedEarnings: true, //系统自动计算结果
                            manualAdjustment: true,  //人工调整：客服主管/财务可对“单个陪玩-单个订单”调整收益（你明确要求）
                            finalEarnings: true, //finalEarnings = calculatedEarnings + manualAdjustment
                            paymentStatus: true,  //打款状态
                            clubEarnings: true,  //俱乐部收益
                            csEarnings: true,  //客服收益
                            inviteEarnings: true,  //邀请收益
                        },
                    },
                },
            });
            if (!order) throw new NotFoundException('订单不存在');
            // 2) 幂等：已最终结单
            if (order.status === OrderStatus.COMPLETED) {
                throw new BadRequestException('已确认结单，若有结算问题请通过-结算工具-重新结算');
            }
            // 3) 必须处于“已结单待确认”（方案2/更规范）
            const PENDING: any = (OrderStatus as any).COMPLETED_PENDING_CONFIRM;
            if (!PENDING) {
                throw new BadRequestException('当前系统未启用“已结单待确认”状态，无法确认结单');
            }
            if (order.status !== PENDING) {
                throw new BadRequestException('仅“已结单待确认”阶段允许确认结单');
            }

            if (!order) throw new BadRequestException('订单不存在');
            // ✅ 允许在确认结单弹窗里录“补收”（小时单）
            // 规则：只有当 dto.paidAmount > 原 paidAmount 时才视为补收
            // 注意：补收逻辑复用 tx 内 helper，避免嵌套 transaction  需要更新订单的补收金额，确认总小时数。补收即视为已收款
            const billingMode: BillingMode | undefined = this.getBillingModeFromOrder(order);
            if (!billingMode) throw new BadRequestException('订单缺少 billingMode');

            const newPaidAmount = dto?.paidAmount === undefined || dto?.paidAmount === null ? undefined : Number(dto.paidAmount);
            if (newPaidAmount !== undefined) {
                // 仅小时单允许补收（若你未来要扩展到其它单型，这里放开并改 helper 校验即可）
                if (billingMode === BillingMode.HOURLY) {
                    // throw new BadRequestException('仅小时单允许在确认结单时录入补收实付金额,这里忽略前端入参。不是做阻断处理');

                    const oldPaid = Number((order as any).paidAmount ?? 0);
                    if (!Number.isFinite(newPaidAmount) || newPaidAmount < 0) {
                        throw new BadRequestException('paidAmount 非法');
                    }
                    if (newPaidAmount > oldPaid) {
                        await this.applyPaidAmountUpdateInTx(tx, order, newPaidAmount, operatorId, remark, dto?.confirmPaid,);
                    } else if (newPaidAmount < oldPaid) {
                        // 方案B：确认结单入口不允许减少实付（避免口径被破坏）
                        throw new BadRequestException('确认结单时实付金额仅允许不变或增加（补收），不允许减少');
                    }
                    order.paidAmount = newPaidAmount
                }
                // 等于 oldPaid：允许，等价于不补收
            }

            // ) 必须已收款（补收时 confirmPaid 默认 true 会顺带把 isPaid 标记上）
            const orderAfterPaid = await tx.order.findUnique({
                where: {id: orderId},
                select: {id: true, isPaid: true, isGifted: true, paidAmount: true, paymentTime: true},
            });

            if (!orderAfterPaid) throw new NotFoundException('订单不存在');
            if ((orderAfterPaid as any).isPaid !== true && (orderAfterPaid as any).isGifted !== true) {
                throw new BadRequestException('未收款订单不允许最终确认结单');
            }

            const dispatches = [...(order.dispatches ?? [])].sort(
                (a, b) => (a.round ?? 0) - (b.round ?? 0),
            );
            if (!dispatches.length) {
                throw new BadRequestException('未找到可用于结算的派单轮次');
            }

            let settlementsToCreate: any[] = [];
            const modePlayAllocList = dto?.modePlayAllocList;
            switch (billingMode) {
                case BillingMode.HOURLY:
                    settlementsToCreate = await computeBillingHours(order as any);
                    break;
                case BillingMode.GUARANTEED:
                    settlementsToCreate = await computeBillingGuaranteed(order as any);
                    break;
                case BillingMode.MODE_PLAY:
                    settlementsToCreate = await computeBillingMODEPLAY(order as any, modePlayAllocList);
                    break;
                default:
                    throw new BadRequestException('未知 billingMode');
            }
            const result = await this.applyRepair_ByCachedSettlementsTxV2({
                tx,
                orderId,
                operatorId,
                settlements: settlementsToCreate,
            });

            //  ✅ 置为最终 COMPLETED
            const updated = await tx.order.update({
                where: {id: orderId},
                data: {status: OrderStatus.COMPLETED},
                select: {id: true, status: true, isPaid: true, paidAmount: true},
            });
            // 日志
            await this.writeUserLog(tx, {
                userId: operatorId,
                action: 'CONFIRM_COMPLETE_ORDER',
                targetType: 'ORDER',
                targetId: orderId,
                oldData: {
                    settlementBatchId: result.settlementBatchId,
                    status: order.status,
                    isPaid: (order as any).isPaid ?? false,
                    paidAmount: Number((order as any).paidAmount ?? 0),
                } as any,
                newData: {
                    status: updated.status,
                    isPaid: updated.isPaid,
                    paidAmount: Number(updated.paidAmount ?? 0),
                } as any,
                remark: remark || '客服确认最终结单（含补收/重算/钱包对齐）',
            });
            return updated;
        });
    }

    /*** -----------------------------
     * 退款功能
     * todo 1-24需确认是否将所有生成流水都处理退款。无论什么状态
     * -----------------------------*/
    async refundOrder(orderId: number, operatorId: number, remark?: string) {
        orderId = Number(orderId);
        operatorId = Number(operatorId);
        if (!orderId) throw new BadRequestException('orderId 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');

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
        if (hasPaid) throw new BadRequestException('存在已打款结算记录，禁止退款（请先走财务冲正流程）');

        const now = new Date();

        await this.prisma.$transaction(async (tx) => {
            // 1) 订单状态置 REFUNDED（要“结单状态并标记退款”：这里用 REFUNDED 即“已结单且已退款”）
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
                await this.wallet.reverseOrderSettlementEarnings({orderId}, tx);
            }
        });
        await this.logOrderAction(operatorId, orderId, 'REFUND_ORDER', {
            remark: remark ?? null,
            clearedSettlements: (order.settlements?.length ?? 0) > 0,
            clearedCount: order.settlements?.length ?? 0,
        });

        return this.getOrderDetail(orderId);
    }

    /*** -----------------------------
     * 订单编辑
     * -----------------------------*/
    async updateOrderEditable(dto: any, operatorId: number) {
        operatorId = Number(operatorId);
        const orderId = Number(dto?.id);
        if (!orderId) throw new BadRequestException('id 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');

        const order = await this.prisma.order.findUnique({
            where: {id: orderId},
            include: {project: true},
        });
        if (!order) throw new NotFoundException('订单不存在');

        // 未结单才允许编辑
        const forbid = new Set<OrderStatus>([OrderStatus.COMPLETED, OrderStatus.REFUNDED]);
        if (forbid.has(order.status)) throw new BadRequestException('已结单/已退款订单不允许编辑');

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

    /*** -----------------------------
     * 确认收款（管理端/财务）
     * - 这是财务动作，不属于“订单编辑”
     * - 允许在已结单后执行（先打后付的典型场景）
     * - 允许修正最终实收金额（paidAmount）
     * - 强制覆盖 paymentTime 为当前时间，并将 isPaid 标记为 true
     * -----------------------------*/
    async markOrderPaid(dto: MarkPaidDto, operatorId: number) {
        operatorId = Number(operatorId);
        const orderId = Number((dto as any)?.id);
        const paidAmount = Number((dto as any)?.paidAmount);

        if (!operatorId) throw new BadRequestException('未登录或无权限操作');
        if (!orderId) throw new BadRequestException('id 必填');
        if (!Number.isFinite(paidAmount)) throw new BadRequestException('paidAmount 非法');

        // 只取本方法需要的字段，避免 include 太重
        const order = await this.prisma.order.findUnique({
            where: {id: orderId},
            select: {
                id: true,
                status: true,
                isGifted: true,
                isPaid: true,
                paidAmount: true,
                paymentTime: true,
                autoSerial: true,
                projectId: true,
            },
        });

        if (!order) throw new NotFoundException('订单不存在');

        // 赠送单不收款，避免误操作导致统计混乱
        if (order.isGifted) {
            throw new BadRequestException('赠送单不需要确认收款');
        }

        // 已退款订单不允许确认收款，避免状态冲突
        if (order.status === OrderStatus.REFUNDED) {
            throw new BadRequestException('已退款订单不允许确认收款');
        }

        // 防止重复确认
        if (order.isPaid) {
            throw new ConflictException('订单已确认收款，无需重复操作');
        }

        const now = new Date();

        const updated = await this.prisma.order.update({
            where: {id: orderId},
            data: {
                // 最终实收金额以本次确认为准（支持补差/改价）
                paidAmount,

                // 人工确认收款：写标记 + 写时间
                isPaid: true,
                paymentTime: now,
            },
        });

        await this.logOrderAction(operatorId, orderId, 'MARK_PAID', {
            autoSerial: order.autoSerial,
            before: {
                isPaid: order.isPaid,
                paidAmount: order.paidAmount,
                paymentTime: order.paymentTime,
            },
            after: {
                isPaid: true,
                paidAmount,
                paymentTime: now,
            },
            remark: (dto as any)?.remark ?? null,
        });

        return this.getOrderDetail(orderId);
    }

    /**
     * ARCHIVED（存单）轮修复：按“本轮总保底进度(万)”均分到当前轮所有参与者，并触发“仅重算结算、不动钱包”
     * - 仅用于保底单（BillingMode.GUARANTEED / BASE）
     * - 允许负数（炸单修正）
     * - 不新增钱包流水：allowWalletSync=false
     * - 结算记录采取“覆盖”策略（先清理本轮结算，再按最新进度重建）
     */
    /**
     * ARCHIVED（存单）轮修复（不触发重算）：
     * - GUARANTEED/BASE：按“本轮总保底进度(万)”均分到本轮所有参与者（更新 OrderParticipant.progressBaseWan）
     * - HOURLY：修复本轮 billableHours（更新 OrderDispatch.billableHours），不涉及 OrderParticipant
     *
     * 共同约束：
     * - 仅允许 ARCHIVED
     * - 不触发结算重算（不 deleteMany，不 createSettlementsForDispatch，不动钱包）
     * - 允许负数（保底单：炸单修正）
     */
    async updateArchivedDispatchProgressTotal(
        dispatchId: number,
        totalProgressBaseWan: number,
        operatorId: number,
        remark?: string,
        // ✅ Controller 直接透传前端参数：最小扩展
        fixType?: 'GUARANTEED' | 'HOURLY',
        billableHours?: number,
    ) {
        dispatchId = Number(dispatchId);
        operatorId = Number(operatorId);

        const totalInt = Math.trunc(Number(totalProgressBaseWan));
        const hoursInt = Number(billableHours);

        if (!dispatchId) throw new BadRequestException('dispatchId 必填');
        if (!operatorId) throw new BadRequestException('未登录或无权限操作');

        const splitEvenlyInt = (total: number, n: number) => {
            if (n <= 0) return [];
            const base = Math.trunc(total / n); // toward zero
            const rem = total - base * n; // could be negative
            const arr = new Array(n).fill(base);
            const k = Math.abs(rem);
            for (let i = 0; i < k; i++) {
                arr[i] += rem > 0 ? 1 : -1;
            }
            return arr;
        };

        return this.prisma.$transaction(async (tx) => {
            // 1) 读取 dispatch + order（事务内一致性）
            const dispatch = await tx.orderDispatch.findUnique({
                where: {id: dispatchId},
                include: {
                    order: {include: {project: true}},
                    participants: true,
                },
            });
            if (!dispatch) throw new NotFoundException('派单批次不存在');

            // 2) 仅允许 ARCHIVED
            if ((dispatch as any).status !== (DispatchStatus as any).ARCHIVED) {
                throw new BadRequestException('仅存单（ARCHIVED）轮允许修复');
            }

            // 3) 读取计费模式（以订单创建时快照/规则为准）
            const billingMode: BillingMode | undefined = this.getBillingModeFromOrder(dispatch.order as any);

            const GUARANTEED: any = (BillingMode as any).GUARANTEED ?? (BillingMode as any).BASE;
            const HOURLY: any = (BillingMode as any).HOURLY;

            // ✅ fixType 缺省：为了兼容旧前端/旧调用，默认按 GUARANTEED
            const fixTypeFinal: 'GUARANTEED' | 'HOURLY' = (fixType as any) || 'GUARANTEED';

            // =========================
            // A) HOURLY：只修 billableHours
            // =========================
            if (fixTypeFinal === 'HOURLY') {
                if (!HOURLY || billingMode !== HOURLY) {
                    throw new BadRequestException('仅小时单允许修复 billableHours');
                }
                if (!Number.isFinite(hoursInt)) throw new BadRequestException('billableHours 非法');

                const oldHours = Number((dispatch as any).billableHours ?? 0);

                await tx.orderDispatch.update({
                    where: {id: dispatchId},
                    data: {billableHours: hoursInt},
                });

                // 日志
                const parts = Array.isArray((dispatch as any).participants) ? (dispatch as any).participants : [];
                const participantCount = parts.filter((p: any) => Number(p?.userId) > 0).length;

                await this.writeUserLog(tx, {
                    userId: operatorId,
                    action: 'ARCHIVED_FIX_HOURS',
                    targetType: 'ORDER_DISPATCH',
                    targetId: dispatchId,
                    oldData: {
                        dispatchId,
                        billableHours: oldHours,
                        participantCount,
                    } as any,
                    newData: {
                        dispatchId,
                        billableHours: hoursInt,
                    } as any,
                    remark: remark || `ARCHIVED_FIX_HOURS=${hoursInt}（仅更新 billableHours，不触发重算）`,
                });

                return {orderId: dispatch.orderId, dispatchId, billableHours: hoursInt};
            }

            // =========================
            // B) GUARANTEED/BASE：均分 progressBaseWan（不重算）
            // =========================
            if (!GUARANTEED || billingMode !== GUARANTEED) {
                throw new BadRequestException('仅保底单允许修复保底进度');
            }
            if (!Number.isFinite(totalInt)) throw new BadRequestException('totalProgressBaseWan 非法');

            // 当前轮参与者：允许 isActive=false（存单后已归档），只要 userId 合法即可
            const parts = Array.isArray((dispatch as any).participants) ? (dispatch as any).participants : [];
            const activeParts = parts.filter((p: any) => Number(p?.userId) > 0);
            if (!activeParts.length) {
                throw new BadRequestException('该轮没有可修复的参与者');
            }

            // 均分
            const splits = splitEvenlyInt(totalInt, activeParts.length);

            // 更新参与者 progressBaseWan（逐条更新，保证每个人不同值）
            for (let i = 0; i < activeParts.length; i++) {
                const p = activeParts[i];
                await tx.orderParticipant.update({
                    where: {id: Number(p.id)},
                    data: {progressBaseWan: splits[i] ?? 0},
                });
            }

            // 日志（不再写 settlementBatchId，因为不重算）
            await this.writeUserLog(tx, {
                userId: operatorId,
                action: 'ARCHIVED_FIX_TOTAL_WAN',
                targetType: 'ORDER_DISPATCH',
                targetId: dispatchId,
                oldData: {
                    dispatchId,
                    totalProgressBaseWan: parts.reduce((s: number, p: any) => s + Number(p?.progressBaseWan ?? 0), 0),
                    participantCount: activeParts.length,
                } as any,
                newData: {
                    dispatchId,
                    totalProgressBaseWan: totalInt,
                    splits,
                } as any,
                remark: remark || `ARCHIVED_FIX_TOTAL_WAN=${totalInt}（均分到${activeParts.length}人；不触发重算）`,
            });

            return {orderId: dispatch.orderId, dispatchId, totalProgressBaseWan: totalInt, splits};
        });
    }


    /**
     * ✅ 钱包对齐修复
     * - 不再考虑其他场景和状态，统一重算(并查询是否已经有对应的结算流水，如果有，直接删除或覆盖)。
     * 1. 先查询出派单记录所有的轮次和每轮的参与者
     * 2. 获取计算的必须的重要参数。
     * - 区分订单类型：保底单→ 订单总金额、订单可分配额度=订单总保底额度、对应的抽成比例（订单设定的抽成比例 customClubRate > 项目的抽成比例 GameProject.clubRate > 参与者对应的等级比例 User.staffRating.rate）
     * 3. 计算收益：
     * 3.1 保底单计算(每轮进度可能存在负数，则整个订单的保底跟着增加。可分配资金也会增加)
     *    保底单存单计算公式：单人收入=本轮贡献/(订单保底/订单金额)/本轮参与人数*对应的抽成比例
     * 3.1.1 保底单重算(已存单)：先获取状态为已存单的所有轮次，按顺序计算，获取每轮其参与者的贡献(多人均分)，按照上面公式进行计算。同时订单剩余可分配额度 = 订单可分配额度 - 本轮贡献。
     *     保底单结单计算公式：单人收入=剩余可分配额度(或者订单剩余金额)/(订单保底/订单金额)/本轮参与人数*对应的抽成比例
     * 3.1.2 保底单重算(已结单)：最后一轮一定是已结单，并且订单剩余可分配额度一定是大于0。
     * 3.2 小时单计算
     * 本轮时长计算规则：(存/结单时间-接单时间，取小时整数后，分钟数最低0.5小时为最小单位。低于18分钟不计算，18-45分钟算0.5小时，超出45分钟不足60分钟算一小时)
     * 订单剩余可分配资金需要记录，用作最后一组存单使用，记录方式，总实收
     * 3.2.1 小时单存单计算公式：单人收入=本轮时长*(总收益/总时长)/本轮参与人数*对应的抽成比例
     * 3.2.2 小时单结单计算公式：单人收入=订单剩余金额/本轮参与人数*对应的抽成比例
     * 3.3 dryRun=true时，返回该订单的已有分红数据，只展示差异。
     * - 幂等：重复执行不会重复计入余额
     * -  dryRun=false或为空时，再落库。
     */

    async repairWalletForOrderSettlementsV1(params: {
        orderId: number;
        operatorId: number;
        reason?: string;
        dryRun?: boolean;
        applyRepair?: boolean;
        type?: '' | 'RECALCULATE';
        scope?: 'COMPLETED_AND_ARCHIVED' | 'COMPLETED_ONLY' | 'ARCHIVED_ONLY';
        modePlayAllocList?: any //趣味玩法单 客服设定的每轮收益
    }) {
        const {
            orderId,
            dryRun = false,
            applyRepair = false,
            operatorId,
            reason,
            modePlayAllocList
        } = params;

        return this.prisma.$transaction(async (tx) => {
            // 1) 并发保护
            await this.assertOrderNotSettlingOrThrow(
                tx,
                orderId,
                '订单正在结算处理中，禁止历史结算修复',
            );

            // ===============================
            // applyRepair：直接复用缓存结果
            // ===============================
            if (applyRepair) {
                const cached = this.settlementRepairCache.get(orderId);
                if (!cached?.length) throw new BadRequestException('未找到可应用的修复结果，请先 dryRun');

                const result = await this.applyRepair_ByCachedSettlementsTxV1({
                    tx,
                    orderId,
                    operatorId,
                    reason,
                });
                return result;
            }

            // ===============================
            // dryRun / 默认：重新计算 settlement
            // ===============================
            const scope = params.scope ?? 'COMPLETED_AND_ARCHIVED';
            const inStatuses =
                scope === 'COMPLETED_ONLY'
                    ? [DispatchStatus.COMPLETED as any]
                    : scope === 'ARCHIVED_ONLY'
                    ? [DispatchStatus.ARCHIVED as any]
                    : [DispatchStatus.COMPLETED as any, DispatchStatus.ARCHIVED as any];

            const dispatchWhere =
                params?.type === 'RECALCULATE'
                    ? undefined
                    : {status: {in: inStatuses}};

            const order = await tx.order.findUnique({
                where: {id: orderId},
                select: {
                    id: true,
                    paidAmount: true,
                    projectSnapshot: true,
                    status: true,
                    orderQuantity: true,
                    baseAmountWan: true,
                    customClubRate: true,
                    receivableAmount: true,
                    dispatcherId: true,
                    dispatcher: {select: {name: true, userType: true}},
                    dispatches: {
                        ...(dispatchWhere ? {where: dispatchWhere} : {}),
                        select: {
                            id: true,
                            round: true,
                            status: true,
                            acceptedAllAt: true,
                            archivedAt: true,
                            completedAt: true,
                            deductMinutesValue: true,
                            billableHours: true,
                            participants: {
                                select: {
                                    userId: true,
                                    isActive: true,
                                    acceptedAt: true,
                                    progressBaseWan: true,
                                    user: {
                                        select: {name: true, staffRating: {select: {rate: true}}},
                                    },
                                },
                            },
                        },
                    },
                    settlements: {
                        where: {orderId},
                        select: {
                            id: true,
                            dispatchId: true,
                            userId: true,
                            user: {select: {name: true, id: true}},
                            settlementType: true, // 结算类型： EXPERIENCE：体验/福袋（每 3 天批次结算） REGULAR：正价（按月批次结算）
                            calculatedEarnings: true, //系统自动计算结果
                            manualAdjustment: true,  //人工调整：客服主管/财务可对“单个陪玩-单个订单”调整收益（你明确要求）
                            finalEarnings: true, //finalEarnings = calculatedEarnings + manualAdjustment
                            paymentStatus: true,  //打款状态
                            clubEarnings: true,  //俱乐部收益
                            csEarnings: true,  //客服收益
                            inviteEarnings: true,  //邀请收益
                        },
                    },
                },
            });

            if (!order) throw new BadRequestException('订单不存在');
            const paidAmount = roundMix1(toNum(order.paidAmount));
            if (!Number.isFinite(paidAmount) || paidAmount < 0) {
                throw new BadRequestException('订单 paidAmount 非法，无法计算');
            }
            const projectSnap: any = order.projectSnapshot;
            const billingMode = projectSnap?.billingMode;
            if (!billingMode) {
                throw new BadRequestException('订单缺少 billingMode');
            }

            const dispatches = [...(order.dispatches ?? [])].sort(
                (a, b) => (a.round ?? 0) - (b.round ?? 0),
            );
            if (!dispatches.length) {
                throw new BadRequestException('未找到可用于结算的派单轮次');
            }

            let settlementsToCreate: any[] = [];
            const existingSettlements = order?.settlements;
            switch (billingMode) {
                case BillingMode.HOURLY:
                    settlementsToCreate = await computeBillingHours(order as any);
                    break;
                case BillingMode.GUARANTEED:
                    settlementsToCreate = await computeBillingGuaranteed(order as any);
                    break;
                case BillingMode.MODE_PLAY:
                    settlementsToCreate = await computeBillingMODEPLAY(order as any, modePlayAllocList);
                    break;
                default:
                    throw new BadRequestException('未知 billingMode');
            }

            // 2) 写入临时缓存（覆盖旧的）
            this.settlementRepairCache.set(orderId, settlementsToCreate);
            const plan = compareSettlementsToPlan({
                existingSettlements,
                settlementsToCreate,
                dispatches
            })

            return {
                dryRun,
                scope,
                billingMode,
                orderSummary: {
                    orderId,
                    paidAmount,
                    orderQuantity: order.orderQuantity,
                    baseAmountWan: order.baseAmountWan ?? null,
                    projectId: projectSnap?.id,
                },
                // 给前端做“前后对比 UI”用（你可以只取 preview 字段渲染）
                plan,
            };

        });
    }

    /**
     * 清理某个订单历史结算产生的副作用数据（最小 DB 操作版）
     * - 删除 WalletTransaction（按 settlementId）
     *   - WalletHold 会因 earningTx onDelete: Cascade 自动删除
     * - 删除 OrderSettlement
     *
     * ⚠️ 注意：此方法不会自动回算 WalletAccount 余额
     *          必须在同一事务里紧接着“重写新流水 + 更新 WalletAccount”，否则余额会不一致
     */
    async cleanupOrderSettlementSideEffects(params: {
        tx: any;
        orderId: number;
    })
    {
        const {tx, orderId} = params;

        // 1) 查 settlementIds（只查 id）
        const settlements = await tx.orderSettlement.findMany({
            where: {orderId},
            select: {id: true},
        });

        if (!settlements?.length) {
            return {
                settlementCount: 0,
                walletTxDeleted: 0,
                settlementDeleted: 0,
                note: '该订单下不存在历史结算数据',
            };
        }

        const settlementIds = settlements.map((s: any) => s.id);

        // 2) 删流水（会级联删 WalletHold）
        const walletTxResult = await tx.walletTransaction.deleteMany({
            where: {settlementId: {in: settlementIds}},
        });

        // 3) 删结算
        const settlementResult = await tx.orderSettlement.deleteMany({
            where: {id: {in: settlementIds}},
        });

        return {
            settlementCount: settlementIds.length,
            walletTxDeleted: walletTxResult?.count ?? 0,
            settlementDeleted: settlementResult?.count ?? 0,
            note: 'WalletHold 由 earningTxId 外键级联删除',
        };
    }

    /**
     * applyRepair：使用缓存的 settlementsToCreate 执行“清理旧数据 + 重建 settlement + 写钱包”
     * - 不重新 compute
     * - 事务内完成，避免半套账
     */
    async applyRepair_ByCachedSettlementsTxV1(params: {
        tx: any;
        orderId: number;
        operatorId: number;
        reason?: string;
    })
    {
        const { tx, orderId, operatorId, reason } = params;

        // =========================
        // Step 0：读取 repair cache
        // =========================
        const settlementsToCreate = this.settlementRepairCache.get(orderId);
        if (!settlementsToCreate?.length) {
            throw new BadRequestException('未找到可应用的修复结果，请先 dryRun');
        }

        // =========================
        // Step 0.1：读取订单（用于冻结时间）
        // =========================
        const order = await tx.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                createdAt: true, // ✅ 用作兜底窗口（不再作为硬过滤）
                projectSnapshot: true,
                dispatches: {
                    select: {
                        id: true,
                        status: true,
                        completedAt: true,
                        acceptedAllAt: true,
                    },
                },
            },
        });
        if (!order) throw new BadRequestException('订单不存在');

        const freezeInfo = computeSettlementFreezeTime({ order });
        const unlockAt = freezeInfo.freezeEndAt;

        // ✅ 本次修复批次号：每次 applyRepair 生成 1 个
        const settlementBatchId = randomUUID();

        // =========================
        // Step 0.3：查旧 settlement
        // =========================
        const oldSettlements = await tx.orderSettlement.findMany({
            where: { orderId },
            select: { id: true, settledAt: true },
        });

        if (!oldSettlements.length) {
            throw new BadRequestException('该订单不存在旧结算记录，无法 applyRepair');
        }

        const oldSettlementIds = oldSettlements.map((s: any) => s.id);

        // =========================
        // Step 0.4：旧 earningTxIds（基于 settlementId）
        // =========================
        const oldEarningTxs = await tx.walletTransaction.findMany({
            where: { settlementId: { in: oldSettlementIds } },
            select: { id: true },
        });
        const oldEarningTxIds = oldEarningTxs.map((t: any) => t.id);

        // =========================
        // Step 1：标准 settlement 回滚（只回滚“还能被 settlementId 定位到”的那批）
        // =========================
        const rollbackSettlementResult = await this.wallet.rollbackOrderWalletImpactInTxV1({
            tx,
            settlementIds: oldSettlementIds,
        });

        // =========================
        // Step 2：识别 & 回滚「历史残留结算流水（sourceType/bizType 精确兜底）」
        // =========================
        // 说明：
        // - 你已确认残留样本：sourceType=ORDER_SETTLEMENT, bizType=SETTLEMENT_EARNING_BASE
        // - 因为有 settledAt 可能晚于流水 createdAt，所以不再依赖 windowStartAt 去过滤“起点”
        // - 仍保留 windowEndAt（防止误扫未来）
        const windowEndAt = new Date();

        // ✅ 精确兜底：按 orderId + sourceType=ORDER_SETTLEMENT + bizType(结算收益类) 命中
        // ⚠️ bizType 必须是你 Prisma enum WalletBizType 的合法值；这里至少包含你已确认的 SETTLEMENT_EARNING_BASE
        const orphanTxs = await tx.walletTransaction.findMany({
            where: {
                orderId,
                sourceType: 'ORDER_SETTLEMENT',
                bizType: { in: ['SETTLEMENT_EARNING_BASE'] as any }, // ✅ 若你已 import WalletBizType，可改为 WalletBizType.SETTLEMENT_EARNING_BASE
                status: { in: ['FROZEN', 'AVAILABLE'] as any },
                createdAt: { lte: windowEndAt },

                // ✅ 避免 double rollback：排除“还能被 Step1 回滚的旧 settlementId 那批”
                OR: [{ settlementId: null }, { settlementId: { notIn: oldSettlementIds } }],
            },
            select: {
                id: true,
                userId: true,
                direction: true,
                status: true,
                amount: true,
                settlementId: true,
                bizType: true,
                sourceType: true,
                sourceId: true,
                createdAt: true,
            },
        });

        // 2.3 回滚残留流水对 WalletAccount 的影响
        const orphanAgg = new Map<number, { availableDelta: number; frozenDelta: number }>();

        const addDelta = (userId: number, a: number, f: number) => {
            const cur = orphanAgg.get(userId) ?? { availableDelta: 0, frozenDelta: 0 };
            cur.availableDelta = round2(cur.availableDelta + a);
            cur.frozenDelta = round2(cur.frozenDelta + f);
            orphanAgg.set(userId, cur);
        };

        for (const t of orphanTxs) {
            const amount = Number((t as any).amount ?? 0);
            if (!t.userId || !amount) continue;

            const status = (t as any).status;
            if (status !== 'FROZEN' && status !== 'AVAILABLE') continue;

            const sign = (t as any).direction === 'OUT' ? -1 : 1;
            const impact = round2(sign * amount);

            if (status === 'AVAILABLE') addDelta(t.userId, -impact, 0);
            if (status === 'FROZEN') addDelta(t.userId, 0, -impact);
        }

        const orphanRollbackResult: any[] = [];

        for (const [userId, delta] of orphanAgg.entries()) {
            await this.wallet.ensureWalletAccount(userId, tx);

            const before = await tx.walletAccount.findUnique({
                where: { userId },
                select: { availableBalance: true, frozenBalance: true },
            });

            const data: any = {};
            if (delta.availableDelta !== 0) {
                data.availableBalance =
                    delta.availableDelta > 0
                        ? { increment: Math.abs(delta.availableDelta) }
                        : { decrement: Math.abs(delta.availableDelta) };
            }
            if (delta.frozenDelta !== 0) {
                data.frozenBalance =
                    delta.frozenDelta > 0
                        ? { increment: Math.abs(delta.frozenDelta) }
                        : { decrement: Math.abs(delta.frozenDelta) };
            }

            if (Object.keys(data).length === 0) continue;

            const after = await tx.walletAccount.update({
                where: { userId },
                data,
                select: { availableBalance: true, frozenBalance: true },
            });

            orphanRollbackResult.push({
                userId,
                rollbackAvailableDelta: delta.availableDelta,
                rollbackFrozenDelta: delta.frozenDelta,
                before,
                after,
            });
        }

        // =========================
        // Step 3：cleanup（删 settlementId 挂钩数据）
        // =========================
        const cleanupResult = await this.cleanupOrderSettlementSideEffects({ tx, orderId });

        // =========================
        // Step 4：补删旧 releaseTx
        // - 包含：旧 earningTxIds + 残留兜底 earningTxIds
        // =========================
        const orphanEarningTxIds = orphanTxs.map((t: any) => t.id);
        const earningIdsForReleaseCleanup = Array.from(
            new Set([...(oldEarningTxIds ?? []), ...(orphanEarningTxIds ?? [])]),
        );

        let deletedOldReleaseTxCount = 0;
        if (earningIdsForReleaseCleanup.length > 0) {
            const r = await tx.walletTransaction.deleteMany({
                where: {
                    sourceType: 'WALLET_HOLD_RELEASE',
                    sourceId: { in: earningIdsForReleaseCleanup },
                    NOT: { status: 'REVERSED' as any },
                },
            });
            deletedOldReleaseTxCount = r?.count ?? 0;
        }

        // =========================
        // Step 5：删残留兜底流水（sourceType/bizType 命中的那批）
        // =========================
        const orphanTxIds = orphanTxs.map((t: any) => t.id);

        let deletedOrphanTxCount = 0;
        if (orphanTxIds.length > 0) {
            const r = await tx.walletTransaction.deleteMany({
                where: { id: { in: orphanTxIds } },
            });
            deletedOrphanTxCount = r?.count ?? 0;
        }

        // =========================
        // Step 6：重建 settlement + 新流水
        // =========================
        const settlementCreateData = settlementsToCreate
            .filter((s: any) => {
                if (!s?.userId) return false;
                if (!s?.dispatchId) throw new BadRequestException(`settlementsToCreate 缺 dispatchId：userId=${s.userId}`);
                return true;
            })
            .map((s: any) => ({
                orderId,
                dispatchId: Number(s.dispatchId),
                userId: Number(s.userId),
                settlementType: s.settlementType,
                calculatedEarnings: s.calculatedEarnings,
                manualAdjustment: s.manualAdjustment,
                finalEarnings: s.finalEarnings,
                settlementBatchId,
                paymentStatus: 'UNPAID',
            }));

        if (!settlementCreateData.length) {
            throw new BadRequestException('settlementsToCreate 为空或缺少 userId/dispatchId，无法重建');
        }
        const keys = settlementCreateData.map(s =>
            `${s.dispatchId}_${s.userId}_${s.settlementType}`
        );

        const dupKeys = keys.filter((k, i) => keys.indexOf(k) !== i);

        console.error('DEBUG_SETTLEMENT_CREATE_KEYS', {
            total: settlementCreateData.length,
            keys,
            dupKeys,
        });

        await tx.orderSettlement.createMany({ data: settlementCreateData as any });

        const createdSettlements = await tx.orderSettlement.findMany({
            where: { orderId, settlementBatchId },
            select: { id: true, userId: true, dispatchId: true, finalEarnings: true },
        });

        if (createdSettlements.length !== settlementCreateData.length) {
            throw new BadRequestException(
                `重建结算条数不一致：期望=${settlementCreateData.length}, 实际=${createdSettlements.length}`,
            );
        }

        for (const s of createdSettlements) {
            await this.wallet.applySettlementEarningToWalletV1({
                tx,
                userId: s.userId,
                settlementId: s.id,
                orderId,
                dispatchId: s.dispatchId,
                finalEarnings: Number(s.finalEarnings ?? 0),
                unlockAt,
                freezeWhenPositive: true,
            });
        }

        // =========================
        // 最终断言：不应再存在“旧的 ORDER_SETTLEMENT + SETTLEMENT_EARNING_BASE”残留
        // - 注意：新流水也会产生同类 bizType/sourceType，所以必须限定 settlementId 属于“本次新建”
        // =========================
        const createdSettlementIds = createdSettlements.map((s: any) => s.id);

        const remainSuspect = await tx.walletTransaction.count({
            where: {
                orderId,
                sourceType: 'ORDER_SETTLEMENT',
                bizType: { in: ['SETTLEMENT_EARNING_BASE'] as any },
                status: { in: ['FROZEN', 'AVAILABLE'] as any },
                createdAt: { lte: new Date() },
                OR: [{ settlementId: null }, { settlementId: { notIn: createdSettlementIds } }],
            },
        });

        if (remainSuspect > 0) {
            throw new BadRequestException(`修复后仍存在旧结算残留流水 remain=${remainSuspect}`);
        }

        // =========================
        // 写审计日志
        // =========================
        await this.writeUserLog(tx, {
            userId: operatorId,
            action: 'REPAIR_WALLET_BY_SETTLEMENTS_V2',
            targetType: 'ORDER',
            targetId: orderId,
            oldData: {
                oldSettlementIds,
                rollbackSettlementResult,
                cleanupResult,
                orphanRollbackResult,
                deletedOldReleaseTxCount,
                deletedOrphanTxCount,
                reason: reason ?? null,
            } as any,
            newData: {
                settlementBatchId,
                rebuiltSettlementCount: createdSettlements.length,
                freezeDays: freezeInfo.freezeDays,
                freezeStartAt: freezeInfo.freezeStartAt,
                freezeEndAt: freezeInfo.freezeEndAt,
            } as any,
            remark: `历史结算修复+结算收益残留治理（V2,batch=${settlementBatchId}）`,
        });

        return {
            mode: 'APPLY_REPAIR_V2',
            orderId,
            settlementBatchId,
            cleanupResult,
            rebuiltSettlementCount: createdSettlements.length,
            freezeDays: freezeInfo.freezeDays,
            freezeStartAt: freezeInfo.freezeStartAt,
            freezeEndAt: freezeInfo.freezeEndAt,
            rollbackSettlementResult,
            orphanRollbackResult,
            deletedOldReleaseTxCount,
            deletedOrphanTxCount,
        };
    }




    /**
     * 使用settlementsToCreate 执行“重建 settlement + 写钱包”
     * - 不重新 compute
     * - 事务内完成，避免半套账
     */
    async applyRepair_ByCachedSettlementsTxV2(params: {
        tx: any;
        orderId: number;
        operatorId: number;
        settlements: any;
    }) {
        const { tx, orderId, settlements } = params;

        const settlementsToCreate = settlements;
        if (!settlementsToCreate?.length) {
            throw new BadRequestException('未找到可应用的修复结果，请先 dryRun');
        }

        // 1) 读取订单（仅用于计算冻结截止时间 unlockAt）
        const order = await tx.order.findUnique({
            where: { id: orderId },
            select: {
                id: true,
                projectSnapshot: true,
                dispatches: { select: { id: true, status: true, completedAt: true, acceptedAllAt: true } },
            },
        });
        if (!order) throw new BadRequestException('订单不存在');

        const freezeInfo = computeSettlementFreezeTime({ order });
        const unlockAt = freezeInfo.freezeEndAt;

        // ✅ 本次修复批次号：每次 applyRepair 生成 1 个
        const settlementBatchId = randomUUID();

        // 2) 组装目标结算（用于 upsert 覆盖）
        const settlementUpsertInputs = settlementsToCreate
            .filter((s: any) => {
                if (!s?.userId) return false;
                if (!s?.dispatchId) throw new BadRequestException(`settlementsToCreate 缺 dispatchId：userId=${s.userId}`);
                if (!s?.settlementType) throw new BadRequestException(`settlementsToCreate 缺 settlementType：userId=${s.userId}`);
                return true;
            })
            .map((s: any) => ({
                orderId,
                dispatchId: Number(s.dispatchId),
                userId: Number(s.userId),
                settlementType: String(s.settlementType),

                calculatedEarnings: s.calculatedEarnings,
                manualAdjustment: s.manualAdjustment,
                finalEarnings: s.finalEarnings,

                settlementBatchId,
                paymentStatus: 'UNPAID',
            }));

        if (!settlementUpsertInputs.length) {
            throw new BadRequestException('settlementsToCreate 为空或缺少 userId/dispatchId/settlementType，无法重建');
        }

        // 3) ✅ 判断是否“旧口径”（历史上是否写过 settlement 相关钱包流水）
        const legacyWalletTxCount = await tx.walletTransaction.count({
            where: {
                orderId,
                OR: [
                    { settlementId: { not: null } },
                    // 如你的旧数据还有别的特征，可在这里加 OR 条件
                ],
            },
        });
        const shouldApplyWallet = legacyWalletTxCount > 0;

        // 4) ✅ upsert 覆盖写入 settlement（避免唯一键冲突）
        const createdSettlementIds: number[] = [];
        const upsertedSettlements: Array<{ id: number; userId: number; dispatchId: number; finalEarnings: any }> = [];

        for (const s of settlementUpsertInputs) {
            const row = await tx.orderSettlement.upsert({
                // ✅ 关键修正：这里必须用 Prisma Client 生成的复合唯一输入名
                where: {
                    dispatchId_userId_settlementType: {
                        dispatchId: s.dispatchId,
                        userId: s.userId,
                        settlementType: s.settlementType,
                    },
                },
                create: s as any,
                update: {
                    calculatedEarnings: s.calculatedEarnings,
                    manualAdjustment: s.manualAdjustment,
                    finalEarnings: s.finalEarnings,
                    settlementBatchId: s.settlementBatchId,
                    paymentStatus: s.paymentStatus,
                } as any,
                select: { id: true, userId: true, dispatchId: true, finalEarnings: true },
            });

            createdSettlementIds.push(row.id);
            upsertedSettlements.push(row);
        }

        // 5) ✅ 兼容新旧口径：决定是否写钱包 + 幂等防重复
        const walletResults: any[] = [];

        if (shouldApplyWallet) {
            // 防重复：若某 settlement 已经存在“结算收益入账流水”，则跳过
            const existedEarningTxs = await tx.walletTransaction.findMany({
                where: {
                    settlementId: { in: createdSettlementIds },
                    bizType: 'SETTLEMENT_EARNING_BASE',
                    // 如果你希望排除冲正状态，可加：
                    // status: { not: 'REVERSED' },
                },
                select: { id: true, settlementId: true },
            });
            const existedSet = new Set(existedEarningTxs.map((x: any) => Number(x.settlementId)));

            for (const s of upsertedSettlements) {
                const sid = Number(s.id);

                if (existedSet.has(sid)) {
                    walletResults.push({
                        userId: s.userId,
                        settlementId: sid,
                        skipped: true,
                        reason: '已存在结算收益流水（旧口径数据），本次修复不重复入账',
                    });
                    continue;
                }

                const w = await this.wallet.applySettlementEarningToWalletV1({
                    tx,
                    userId: s.userId,
                    settlementId: sid,
                    orderId,
                    dispatchId: s.dispatchId,
                    finalEarnings: Number(s.finalEarnings ?? 0),
                    unlockAt,
                    freezeWhenPositive: true,
                });
                walletResults.push({ userId: s.userId, settlementId: sid, wallet: w });
            }
        } else {
            walletResults.push({
                skippedAll: true,
                reason: '新口径订单（未发现历史 settlement 钱包流水），本次仅修复/覆盖结算记录，不生成钱包流水',
            });
        }

        // 6) 新流水快照（用于前端展示对账）
        const newEarningTxs = await tx.walletTransaction.findMany({
            where: { settlementId: { in: createdSettlementIds } },
            select: { id: true },
        });
        const newEarningTxIds = newEarningTxs.map((x: any) => x.id);

        const newWalletTxs = await tx.walletTransaction.findMany({
            where: {
                OR: [
                    { settlementId: { in: createdSettlementIds } },
                    ...(newEarningTxIds.length > 0
                        ? [
                            {
                                sourceType: 'WALLET_HOLD_RELEASE',
                                sourceId: { in: newEarningTxIds },
                            },
                        ]
                        : []),
                ],
            },
            select: {
                id: true,
                userId: true,
                direction: true,
                status: true,
                amount: true,
                availableAfter: true,
                frozenAfter: true,
                settlementId: true,
                sourceType: true,
                sourceId: true,
                createdAt: true,
            },
        });

        const createdTxByUser = groupByUserId(newWalletTxs);
        return {
            createdTxByUser,
            mode: shouldApplyWallet ? 'APPLY_REPAIR_LEGACY_WITH_WALLET' : 'APPLY_REPAIR_RECORD_ONLY',
            orderId,
            settlementBatchId,
            rebuiltSettlementCount: createdSettlementIds.length,
            freezeDays: freezeInfo.freezeDays,
            freezeStartAt: freezeInfo.freezeStartAt,
            freezeEndAt: freezeInfo.freezeEndAt,
            walletResults,
        };
    }




    /** ====================== 陪玩端（不应被管理端 orders 权限误伤） ====================== */

    /*** -----------------------------
     * 陪玩接单
     * -----------------------------*/
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
        if (!participant) throw new BadRequestException('不是该订单的参与者');

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

    /** -----------------------------
     * 陪玩拒单（待接单阶段）
     * ToDo 暂不支持拒单，拒单需调整派单逻辑
     * - 必填拒单原因
     * - participant 标记 rejectedAt + rejectReason，并置 isActive=false 进入历史
     * -----------------------------*/
    async rejectDispatch(dispatchId: number, userId: number, reason: string) {
        dispatchId = Number(dispatchId);
        userId = Number(userId);
        reason = String(reason ?? '').trim();

        if (!dispatchId) throw new BadRequestException('dispatchId 必填');
        if (!userId) throw new BadRequestException('未登录或无权限操作');
        if (!reason) throw new BadRequestException('reason 必填');

        const dispatch = await this.prisma.orderDispatch.findUnique({
            where: {id: dispatchId},
            include: {order: true, participants: true},
        });
        if (!dispatch) throw new NotFoundException('派单批次不存在');

        if (dispatch.status !== DispatchStatus.WAIT_ACCEPT) {
            throw new BadRequestException('当前派单状态不可拒单');
        }

        const participant = dispatch.participants.find((p: any) => Number(p.userId) === userId && p.isActive !== false);
        if (!participant) throw new BadRequestException('不在本轮派单参与者中');
        if (participant.acceptedAt) throw new BadRequestException('已接单，不能拒单');
        if (participant.rejectedAt) throw new BadRequestException('已拒单，无需重复操作');

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

    /** -----------------------------
     * 我的接单记录 / 工作台
     * 我的接单记录（陪玩端/员工端查看自己参与的派单批次）
     * mode: 'WORKBENCH' -> 工作台：只看当前轮 + 自己是有效参与者
     * mode: 'HISTORY'   -> 接单记录：包含拒单/被替换等历史（只要参与过即可）
     * -----------------------------*/
    async listMyDispatches(params: {
        userId: number;
        page: number;
        limit: number;
        status?: string;
        mode?: 'WORKBENCH' | 'HISTORY';
    }) {
        const userId = Number(params.userId);
        const page = Math.max(1, Number(params.page ?? 1));
        const limit = Math.min(100, Math.max(1, Number(params.limit ?? 20)));
        const skip = (page - 1) * limit;

        if (!userId) throw new BadRequestException('userId 缺失');

        const mode = (params.mode ?? 'HISTORY') as 'WORKBENCH' | 'HISTORY';

        const where: any = {};

        if (mode === 'WORKBENCH') {
            // ✅ 工作台：只查“派给我的当前轮”，要求我在本轮仍有效参与（isActive=true 且未拒单）
            where.order = {currentDispatchId: undefined}; // 占位，下面用 AND 写更清晰
            where.AND = [
                {
                    participants: {
                        some: {
                            userId,
                            isActive: true,
                            rejectedAt: null,
                        },
                    },
                },
                // ✅ 当前轮：只能是订单 currentDispatchId 指向的那条 dispatch
                {
                    currentForOrders: {
                        some: {
                            id: {gt: 0}, // 只要存在 currentForOrders 即可
                        },
                    },
                },
            ];
        } else {
            // ✅ 历史：只要参与过（包含拒单/被替换）
            where.participants = {some: {userId}};
        }

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

                    // ✅ 关键修复：participants 不再过滤 userId=当前陪玩
                    // - WORKBENCH：返回本轮所有有效参与者（isActive=true 且未拒单），前端才能看到“另一人”
                    // - HISTORY：返回本轮所有参与者（含拒单/被替换），前端才能展示“拒单记录”
                    participants:
                        mode === 'WORKBENCH'
                            ? {
                                where: {isActive: true, rejectedAt: null},
                                include: {user: {select: {id: true, name: true, phone: true}}},
                            }
                            : {
                                include: {user: {select: {id: true, name: true, phone: true}}},
                            },
                },
            }),
            this.prisma.orderDispatch.count({where}),
        ]);

        return {data, total, page, limit, totalPages: Math.ceil(total / limit)};
    }

    /** -----------------------------
     * 陪玩-我的工作台
     * -----------------------------*/
    async getMyWorkbenchStats(userId: number) {
        userId = Number(userId);
        if (!userId) throw new BadRequestException('未登录或无权限操作');

        const now = new Date();

        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

        const startMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        const endMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

        // ✅ 1) 今日/月 接单次数：存单+结单都算（每轮一次）
        const dispatchParticipantWhere: any = {
            participants: {
                some: {
                    userId,
                    isActive: true,
                    rejectedAt: null,
                },
            },
        };

        const [todayArchiveCount, todayCompleteCount, monthArchiveCount, monthCompleteCount] =
            await Promise.all([
                this.prisma.orderDispatch.count({
                    where: {...dispatchParticipantWhere, archivedAt: {gte: startToday, lte: endToday}},
                }),
                this.prisma.orderDispatch.count({
                    where: {...dispatchParticipantWhere, completedAt: {gte: startToday, lte: endToday}},
                }),
                this.prisma.orderDispatch.count({
                    where: {...dispatchParticipantWhere, archivedAt: {gte: startMonth, lte: endMonth}},
                }),
                this.prisma.orderDispatch.count({
                    where: {...dispatchParticipantWhere, completedAt: {gte: startMonth, lte: endMonth}},
                }),
            ]);

        const todayCount = Number(todayArchiveCount) + Number(todayCompleteCount);
        const monthCount = Number(monthArchiveCount) + Number(monthCompleteCount);

        // ✅ 2) 收入净额：IN - OUT（包含冻结），排除 REVERSED
        // 说明：
        // - 正收益：direction=IN（通常 FROZEN/AVAILABLE 都算）
        // - 炸单负收益：你钱包实现会写 direction=OUT（AVAILABLE），这里会被抵扣
        const incomeBizTypes = [
            'SETTLEMENT_EARNING',       // 兼容旧
            'SETTLEMENT_EARNING_BASE',  // 基础收益
            'SETTLEMENT_EARNING_CARRY', // 补偿收益
            'SETTLEMENT_EARNING_CS',    // 客服分红
            'SETTLEMENT_BOMB_LOSS',     // 炸单损耗（OUT）
        ];

        const baseWhere: any = {
            userId,
            bizType: {in: incomeBizTypes},
            status: {not: 'REVERSED'},
        };

        const [todayAgg, monthAgg] = await Promise.all([
            this.prisma.walletTransaction.aggregate({
                where: {...baseWhere, createdAt: {gte: startToday, lte: endToday}},
                _sum: {amount: true},
            }),
            this.prisma.walletTransaction.aggregate({
                where: {...baseWhere, createdAt: {gte: startMonth, lte: endMonth}},
                _sum: {amount: true},
            }),
        ]);

        // ❗aggregate 无法按 direction 分组，所以最小改动：再查一次 OUT 的 sum（两次 aggregate）
        const [todayOutAgg, monthOutAgg] = await Promise.all([
            this.prisma.walletTransaction.aggregate({
                where: {
                    ...baseWhere,
                    direction: 'OUT',
                    createdAt: {gte: startToday, lte: endToday},
                },
                _sum: {amount: true},
            }),
            this.prisma.walletTransaction.aggregate({
                where: {
                    ...baseWhere,
                    direction: 'OUT',
                    createdAt: {gte: startMonth, lte: endMonth},
                },
                _sum: {amount: true},
            }),
        ]);

        const todayTotal = Number(todayAgg?._sum?.amount ?? 0);
        const monthTotal = Number(monthAgg?._sum?.amount ?? 0);

        const todayOut = Number(todayOutAgg?._sum?.amount ?? 0);
        const monthOut = Number(monthOutAgg?._sum?.amount ?? 0);

        // ✅ 净额 = 总额 - OUT（因为 amount 始终为正数，OUT 用来表达扣款）
        const todayIncome = todayTotal - todayOut;
        const monthIncome = monthTotal - monthOut;

        return {todayCount, todayIncome, monthCount, monthIncome};
    }

    /** ====== 公共方法区（后续应提到utils）========== */
    /** -----------------------------
     * 补收方法？
     * -----------------------------*/
    private async applyPaidAmountUpdateInTx(tx: any, order: any, paidAmount: number, operatorId: number, remark?: string, confirmPaid?: any) {
        if (!Number.isFinite(paidAmount) || paidAmount < 0) {
            throw new BadRequestException('paidAmount 非法');
        }

        // confirmPaid 默认 true（补收一般=钱已收）
        const confirmPaidBool = this.parseBool(confirmPaid, true);

        // 赠送单不允许补收
        if ((order as any).isGifted) throw new BadRequestException('赠送单不允许补收实付金额');

        // 已退款订单不允许补收
        if (order.status === OrderStatus.REFUNDED) throw new BadRequestException('已退款订单不允许补收实付金额');

        // 仅小时单允许补收（你要的是“客服确认结单弹窗里录补收”，目前只对小时单）
        const billingMode: BillingMode | undefined = this.getBillingModeFromOrder(order);
        if (billingMode !== BillingMode.HOURLY) throw new BadRequestException('仅小时单允许补收实付金额');

        // 只允许增加
        const old = Number(order.paidAmount ?? 0);
        if (paidAmount < old) throw new BadRequestException('实付金额仅允许增加（超时补收），不允许减少');

        // 是否标记收款（仅在原来未收款时）
        const shouldMarkPaid = confirmPaidBool && (order as any).isPaid !== true;
        const now = new Date();

        // 金额没变：只在 shouldMarkPaid 时标记收款
        if (paidAmount === old) {
            if (!shouldMarkPaid) return {changed: false};

            await tx.order.update({
                where: {id: order.id},
                data: {isPaid: true, paymentTime: now},
            });

            await this.writeUserLog(tx, {
                userId: operatorId,
                action: 'MARK_PAID_BY_CONFIRM_COMPLETE',
                targetType: 'ORDER',
                targetId: order.id,
                oldData: {
                    paidAmount: old,
                    isPaid: (order as any).isPaid ?? null,
                    paymentTime: order.paymentTime ?? null
                } as any,
                newData: {paidAmount: old, isPaid: true, paymentTime: now} as any,
                remark: remark || `确认结单时确认收款（金额未变）：${old}`,
            });

            return {changed: false};
        }

        // 金额变化：更新 paidAmount，并可顺带确认收款
        await tx.order.update({
            where: {id: order.id},
            data: {
                paidAmount,
                ...(shouldMarkPaid ? {isPaid: true, paymentTime: now} : {}),
            },
        });

        await this.writeUserLog(tx, {
            userId: operatorId,
            action: 'UPDATE_PAID_AMOUNT_BY_CONFIRM_COMPLETE',
            targetType: 'ORDER',
            targetId: order.id,
            oldData: {
                paidAmount: old,
                isPaid: (order as any).isPaid ?? false,
                paymentTime: order.paymentTime ?? null
            } as any,
            newData: {
                paidAmount,
                ...(shouldMarkPaid ? {isPaid: true, paymentTime: now} : {}),
            } as any,
            remark: remark || `确认结单时补收实付：${old} → ${paidAmount}`,
        });

        return {changed: true};
    }


    /** -----------------------------
     * 生成订单序列号：YYYYMMDD-0001 Todo 订单编号得改，这个规则有点丑
     * v0.1：用 DB 查询当日最大序号后 +1
     * -----------------------------*/

    private async generateOrderSerial(): Promise<string> {
        const VERSION = 'V01';

        // 1) 时间片：分钟级（你也可以改成秒级 Date.now() / 1000）
        //    转 base36 后不明显是年月日，但大体递增，利于排序/排查
        const minuteBucket = Math.floor(Date.now() / 60000);
        const timePart = minuteBucket.toString(36).toUpperCase(); // e.g. "MZ9K3A"

        // 2) 随机尾巴：4-6 位（base36），强烈降低并发撞号概率
        const len = randomInt(4, 7); // 4..6
        const max = 36 ** len;
        const rand = randomInt(0, max);
        const randPart = rand.toString(36).toUpperCase().padStart(len, '0');

        // 3) 拼接：无 "-"
        const candidate = `${VERSION}${timePart}${randPart}`;

        // 4) 可选：做一次轻量去重（极小概率撞号时重试）
        //    如果你有 autoSerial 唯一索引，下面逻辑更保险（没有也能用）
        const exists = await this.prisma.order.findFirst({
            where: { autoSerial: candidate },
            select: { id: true },
        });

        if (!exists) return candidate;

    // 极小概率：再来一次（不搞循环，保持简单；你也可以 while 重试 3 次）
    const len2 = randomInt(4, 7);
    const max2 = 36 ** len2;
    const rand2 = randomInt(0, max2);
    const randPart2 = rand2.toString(36).toUpperCase().padStart(len2, '0');
    return `${VERSION}${timePart}${randPart2}`;
    }


/** -----------------------------
     * 审计日志（UserLog）
     * -----------------------------*/
    private async logOrderAction(
        operatorId: number,
        orderId: number,
        action: string,
        newData: any,
        tx?: any,
        remark?: string,
    ) {
        const uid = Number(operatorId);
        if (!uid) {
            throw new BadRequestException('缺少操作人身份（operatorId），请重新登录后重试');
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
                remark,
            },
        });
    }

    /** -----------------------------
     * userLog 写入封装：减少重复 & 后续易统一字段
     * todo  需确认是否跟以上审计日志重叠
     * -----------------------------*/
    private async writeUserLog(
        tx: any,
        data: {
            userId: number;
            action: string;
            targetType: string;
            targetId: number;
            oldData?: any;
            newData?: any;
            remark?: string;
        },
    ) {
        // 防御：operatorId=0/null 时不写
        if (!data?.userId) return;

        await tx.userLog.create({
            data: {
                userId: data.userId,
                action: data.action,
                targetType: data.targetType,
                targetId: data.targetId,
                oldData: data.oldData ?? null,
                newData: data.newData ?? null,
                remark: data.remark ?? null,
            } as any,
        });
    }

    /** -----------------------------
     * 订单轮次 dispatch 结算互斥抢占
     * - 只能从 ACCEPTED -> SETTLING
     * - 抢占成功：当前请求成为“唯一结算者”
     * - 抢占失败：说明另一个请求已经在处理/处理完成
     * -----------------------------*/
    async lockDispatchForSettlementOrThrow(dispatchId: number, tx: any) {
        const locked = await tx.orderDispatch.updateMany({
            where: {id: dispatchId, status: DispatchStatus.ACCEPTED},
            data: {status: DispatchStatus.SETTLING},
        });

        if (locked.count === 0) {
            // ✅ 抢占失败：要么已结算/已存单，要么正在处理中
            throw new BadRequestException('该派单正在结算中或已处理，请刷新后重试');
        }

    }

    /** -----------------------------
     * progress 写入（tx）
     * - Todo 需明确该方法的使用，以及影响范围
     * -----------------------------*/
    private async applyProgressAndDeduct(
        tx: any,
        dispatch: any,
        dto: { progresses?: Array<{ userId: number; progressBaseWan?: number }>; deductMinutesOption?: string },
    ) {
        // ✅ 只处理 progress（保底单）；小时单扣时由 computeAndPersistBillingHours 统一计算并落库
        const progresses = Array.isArray(dto?.progresses) ? dto.progresses : [];
        if (progresses.length === 0) return;

        const parts = Array.isArray(dispatch?.participants) ? dispatch.participants : [];
        const activeParts = parts.filter((p: any) => p?.isActive && !p?.rejectedAt);
        if (activeParts.length === 0) return;

        const normalize = (v: any) => {
            if (v === null || v === undefined) return null;
            const n = Number(v);
            if (!Number.isFinite(n)) return null;
            return roundMix1(n); // ✅ 允许负数
        };

        // ✅ 情况1：只传 1 条（前端未拆分）=> 按人数平均拆分写入每个 active participant
        if (progresses.length === 1 && activeParts.length > 1) {
            const total = normalize(progresses[0]?.progressBaseWan);
            if (total === null) return;

            const n = activeParts.length;
            const avg = roundMix1(total / n);

            // 尾差给最后一个（保证 sum 精确等于 total）
            for (let i = 0; i < n; i++) {
                const part = activeParts[i];
                let v = avg;
                if (i === n - 1) {
                    const sumBeforeLast = roundMix1(avg * (n - 1));
                    v = roundMix1(total - sumBeforeLast);
                }

                await tx.orderParticipant.update({
                    where: {id: part.id},
                    data: {progressBaseWan: v},
                });
            }
            return;
        }

        // ✅ 情况2：传多条（前端已拆分 or 按人录入）=> 精确写入
        const map = new Map<number, number | null>();
        for (const p of progresses) {
            const uid = Number(p?.userId);
            if (!Number.isFinite(uid) || uid <= 0) continue;
            map.set(uid, normalize(p?.progressBaseWan));
        }

        for (const part of activeParts) {
            const uid = Number(part?.userId);
            if (!Number.isFinite(uid) || uid <= 0) continue;
            if (!map.has(uid)) continue;

            await tx.orderParticipant.update({
                where: {id: part.id},
                data: {progressBaseWan: map.get(uid)},
            });
        }
    }


    /** -----------------------------
     * 小时单：计算并落库 billableMinutes / billableHours
     * - 计时：acceptedAllAt -> archivedAt / completedAt（以 action 来决定终点）
     * - 扣时：deductMinutesValue（10/20/.../60）
     * -----------------------------*/
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
            where: {id: dispatch.id},
            data: {
                deductMinutes: deductMinutesOption as any,
                deductMinutesValue: deductValue || null,
                billableMinutes: effectiveMinutes,
                billableHours,
            },
        });

        return {action, rawMinutes, deductValue, effectiveMinutes, billableHours};
    }

    /**
     * 生成结算明细（核心）
     *
     * 结算口径（按最新规则）：
     * - 单次派单 + 本次为结单：直接按订单实付金额 paidAmount 结算全量
     * - 多次派单：使用 computeDispatchRatio（保底进度/结单结剩余等）计算本轮 ratio
     * - 分配方式：优先按 participant.contributionAmount 权重；否则均分
     * - 到手收益 multiplier 优先级：
     *   1) 订单固定抽成（平台抽成）：each * (1 - 抽成)
     *   2) 项目固定抽成（平台抽成）：each * (1 - 抽成)
     *   3) 陪玩分红比例（到手比例）：each * 分红
     *  Todo 最大问题在这里，禁止每轮生成结算明细，最后统一结算
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
    async createSettlementsForDispatch(
        params: {
            orderId: number;
            dispatchId: number;
            mode: 'ARCHIVE' | 'COMPLETE';
            settlementBatchId: string; // ✅ 结算批次号
            allowWalletSync?: boolean; // ✅ 可选：仅重算结算时可关闭钱包同步（默认 true，保持旧行为）
        },
        tx: any, // ✅ 外层事务
    ) {
        const {orderId, dispatchId, mode, settlementBatchId} = params;
        const allowWalletSync = params.allowWalletSync !== false; // 默认 true


        // ===========================
        // v0.2 测试参数：冻结时间用“分钟”
        // ===========================
        const EXPERIENCE_UNLOCK_MINUTES = 3 * 60 * 24;
        const REGULAR_UNLOCK_MINUTES = 7 * 60 * 24;

        // ===========================
        // 客服分红比例（不落库，纯规则）
        // ===========================
        const CUSTOMER_SERVICE_SHARE_RATE = 0.01;

        // ---------- 工具函数 ----------
        const isSet = (v: any) => v !== null && v !== undefined; // ✅ 0 也算已设置
        const normalizeToRatio = (v: any, fallback: number) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            return n > 1 ? n / 100 : n;
        };

        // 1️⃣ 读取订单 & 派单（必须用 tx）
        const order = await tx.order.findUnique({
            where: {id: orderId},
            include: {project: true},
        });
        if (!order) throw new NotFoundException('订单不存在');

        const dispatch = await tx.orderDispatch.findUnique({
            where: {id: dispatchId},
            include: {participants: true},
        });
        if (!dispatch) throw new NotFoundException('派单批次不存在');

        // // 2️⃣ 本轮参与者（只结算 active 且未拒单的，避免历史重复结算/拒单参与分摊）
        // const participants = (dispatch.participants || []).filter(
        //     (p: any) => p?.isActive && !p?.rejectedAt,
        // );
        // if (participants.length === 0) return true;

        // 2️⃣ 本轮参与者
        // - ✅ 进行中（WAIT_ACCEPT/ACCEPTED/SETTLING 等）：只取 isActive=true，避免把“被替换的历史参与者”重复计入
        // - ✅ 已完成（COMPLETED/ARCHIVED）：参与者已被置为历史（isActive=false），此时必须使用历史参与者来重算/落库
        const dispatchStatus: any = (dispatch as any).status;

        const isFinalized =
            dispatchStatus === (DispatchStatus as any).COMPLETED ||
            dispatchStatus === (DispatchStatus as any).ARCHIVED;

        const participants = (dispatch.participants || []).filter((p: any) => {
            if (p?.rejectedAt) return false;
            return isFinalized ? true : !!p?.isActive;
        });

        if (participants.length === 0) return true;

        // 3️⃣ 本轮基础结算类型（体验单 / 正价单）
        const baseSettlementType = order.type === OrderType.EXPERIENCE ? 'EXPERIENCE' : 'REGULAR';

        // 解冻时间
        const unlockAt =
            baseSettlementType === 'EXPERIENCE'
                ? new Date(Date.now() + EXPERIENCE_UNLOCK_MINUTES * 60 * 1000)
                : new Date(Date.now() + REGULAR_UNLOCK_MINUTES * 60 * 1000);

        // 4️⃣ 分摊规则（原有逻辑兼容）
        const ratioMap = this.buildProgressRatioMap(participants);

        const dispatchCount = await tx.orderDispatch.count({
            where: {orderId},
        });

        // ---------- 4.1) 结算瞬间快照：抽成规则输入 ----------
        const orderCutRaw = isSet(order.customClubRate) ? order.customClubRate : null;

        const snap: any = order.projectSnapshot || {};
        const projectCutRaw = isSet(snap.clubRate)
            ? snap.clubRate
            : isSet(order.project?.clubRate)
                ? order.project.clubRate
                : null;

        // ---------- 4.2) 员工评级抽成快照（仅当订单/项目都未设置抽成时才需要） ----------
        let staffCutMap: Map<number, number> | undefined;

        if (!isSet(orderCutRaw) && !isSet(projectCutRaw)) {
            const userIds = participants.map((p: any) => p.userId);
            const users = await tx.user.findMany({
                where: {id: {in: userIds}},
                select: {id: true, staffRating: {select: {rate: true}}},
            });

            staffCutMap = new Map<number, number>();
            for (const u of users) {
                staffCutMap.set(u.id, Number(u.staffRating?.rate ?? 0));
            }
        }

        const multiplierPriority = isSet(orderCutRaw)
            ? 'ORDER_CUT'
            : isSet(projectCutRaw)
                ? 'PROJECT_CUT'
                : 'PLAYER_CUT';

        // ===========================
        // ✅ 4.3 HOURLY 不走保底口径；GUARANTEED 才走 progress→gross/carry
        // ===========================
        const billingMode =
            (order.projectSnapshot as any)?.billingMode ?? (order.project as any)?.billingMode;

        const isHourly = billingMode === BillingMode.HOURLY;

        // paidAmount 仍要校验（旧口径也依赖它）
        const paidAmount = Number((order as any).paidAmount ?? 0);
        if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
            throw new BadRequestException('订单 paidAmount 非法');
        }

        // ✅ 本轮 progress 汇总（抗“只填自己/重复填同一个值”）
        // ✅ 本轮 progress 汇总（口径统一：progressBaseWan 永远是“每个参与者各自的进度(万)”）
        // - 因此前端传 150/150 时，本轮总进度必须是 300
        // - 允许负数（炸单）
        let hasAnyProgressInput = false;
        let dispatchProgressWan = 0;

        const filledProgress: number[] = [];
        for (const p of participants) {
            const v = (p as any).progressBaseWan;
            if (v === null || v === undefined) continue;
            const n = Number(v);
            if (!Number.isFinite(n)) continue;
            filledProgress.push(roundMix1(n));
        }

        if (filledProgress.length > 0) {
            hasAnyProgressInput = true;
            dispatchProgressWan = roundMix1(filledProgress.reduce((s, x) => s + x, 0));
        }

        console.log(
            '[EARN_DBG][PROGRESS_SUM]',
            'orderId=', orderId,
            'dispatchId=', dispatchId,
            'mode=', mode,
            'participantsLen=', participants.length,
            'filledProgress=', filledProgress,
            'dispatchProgressWan=', dispatchProgressWan,
        );

        // ✅ COMPLETE 自动补齐剩余保底：小时单跳过（没有保底概念）
        if (mode === 'COMPLETE' && !hasAnyProgressInput && !isHourly) {
            const allDispatches = await tx.orderDispatch.findMany({
                where: {orderId},
                select: {participants: {select: {progressBaseWan: true}}},
            });

            let sumProgressWan = 0;
            for (const d of allDispatches) {
                for (const part of d.participants || []) {
                    const v = (part as any).progressBaseWan;
                    if (v === null || v === undefined) continue;
                    const n = Number(v);
                    if (!Number.isFinite(n)) continue;
                    sumProgressWan += n; // ✅ 允许负数
                }
            }

            const baseWan = Number((order as any).baseAmountWan ?? 0);
            if (!Number.isFinite(baseWan) || baseWan <= 0) {
                throw new BadRequestException('订单 baseAmountWan 非法-02');
            }

            const remainingWan = roundMix1(baseWan - sumProgressWan);
            dispatchProgressWan = remainingWan > 0 ? remainingWan : 0;
            hasAnyProgressInput = true;
        }

        // ✅ gross/carry 相关变量：必须都有默认值（避免 undefined）
        let rateWanPerYuan: number | null = null;
        let grossRmb: number | null = null;

        let consumedPaidPool = 0;
        let carryDebt = 0;
        let carryPaid = 0;
        let carryRemaining = 0;
        let remainingPaidPool = 0;

        let repayRmb = 0;
        let normalGrossRmb = 0;
        let excessNormalRmb = 0;

        if (!isHourly && hasAnyProgressInput) {
            const baseAmountWan = Number((order as any).baseAmountWan ?? 0);
            if (!Number.isFinite(baseAmountWan) || baseAmountWan <= 0) {
                throw new BadRequestException('订单 baseAmountWan 非法-01');
            }

            rateWanPerYuan = roundMix1(baseAmountWan / paidAmount);
            grossRmb = roundMix1(dispatchProgressWan / rateWanPerYuan);

            // ✅ carry/pool 聚合
            const allForOrder = await tx.orderSettlement.findMany({
                where: {orderId},
                select: {settlementType: true, calculatedEarnings: true},
            });

            for (const s of allForOrder) {
                const cal = Number((s as any).calculatedEarnings ?? 0);
                if (!Number.isFinite(cal) || cal === 0) continue;

                if ((s as any).settlementType === baseSettlementType) {
                    if (cal > 0) consumedPaidPool += cal;
                    if (cal < 0) carryDebt += -cal;
                }

                if ((s as any).settlementType === 'CARRY_COMPENSATION') {
                    if (cal > 0) carryPaid += cal;
                }
            }

            consumedPaidPool = roundMix1(consumedPaidPool);
            carryDebt = roundMix1(carryDebt);
            carryPaid = roundMix1(carryPaid);

            carryRemaining = Math.max(0, roundMix1(carryDebt - carryPaid));
            remainingPaidPool = Math.max(0, roundMix1(paidAmount - consumedPaidPool));

            // ✅ gross 拆分：repay + normalGross
            if (grossRmb < 0) {
                repayRmb = 0;
                normalGrossRmb = grossRmb; // ✅ 负数
                excessNormalRmb = 0;
            } else if (grossRmb > 0) {
                repayRmb = Math.min(grossRmb, carryRemaining);

                const candidate = roundMix1(grossRmb - repayRmb);
                normalGrossRmb = Math.min(candidate, remainingPaidPool);

                excessNormalRmb = roundMix1(candidate - normalGrossRmb);
            } else {
                repayRmb = 0;
                normalGrossRmb = 0;
                excessNormalRmb = 0;
            }
        } else {
            // ✅ 小时单：强制走旧口径
            grossRmb = null;
            rateWanPerYuan = null;
        }

        // ===========================
        // 5️⃣ 逐个陪玩生成基础结算（幂等）
        // - grossRmb!=null：按 normalGrossRmb 均摊（可负）
        // - grossRmb==null：走旧口径 calcPlayerEarning（小时单）
        // ===========================

        const userIds = participants.map((p: any) => p.userId);
        const existingBase = await tx.orderSettlement.findMany({
            where: {
                dispatchId,
                settlementType: baseSettlementType,
                userId: {in: userIds},
            },
            select: {id: true, userId: true},
        });
        const baseMap = new Map<number, any>();
        for (const e of existingBase) baseMap.set(e.userId, e);

        await Promise.all(
            participants.map(async (p: any, idx: number) => {
                const userId = p.userId;

                let calculated: number;

                if (grossRmb !== null) {
                    console.log(
                        '[EARN_DBG][GROSS_CTX]',
                        'orderId=', orderId,
                        'dispatchId=', dispatchId,
                        'userId=', userId,
                        'participantsLen=', participants.length,
                        'grossRmb=', grossRmb,
                        'normalGrossRmb=', normalGrossRmb,
                        'repayRmb=', repayRmb,
                        'paidAmount=', Number(order?.paidAmount ?? 0),
                        'dispatchProgressWan=', dispatchProgressWan,
                        'rateWanPerYuan=', rateWanPerYuan,
                        'mode=', mode,
                    );
                    const avg = roundMix1(normalGrossRmb / participants.length);
                    calculated = avg;

                    if (idx === participants.length - 1) {
                        const sumBeforeLast = roundMix1(avg * (participants.length - 1));
                        calculated = roundMix1(normalGrossRmb - sumBeforeLast);
                    }
                    console.log(
                        '[EARN_DBG][GROSS_RESULT]',
                        'orderId=', orderId,
                        'dispatchId=', dispatchId,
                        'userId=', userId,
                        'idx=', idx,
                        'avg=', avg,
                        'calculated=', calculated,
                    );
                } else {
                    const ratio = ratioMap.get(p.id) ?? 1;
                    console.log(
                        '[EARN_DBG][INPUT]',
                        'orderId=', orderId,
                        'dispatchId=', dispatchId,
                        'userId=', userId,
                        'participantsLen=', participants.length,
                        'ratio=', ratio,
                        'paidAmount=', Number(order?.paidAmount ?? 0),
                        'grossRmb=', grossRmb,
                        'mode=', mode,
                    );
                    calculated = this.calcPlayerEarning({
                        order,
                        participantsCount: participants.length,
                        ratio,
                        _dbg: {orderId, dispatchId, userId},
                    });
                    console.log(
                        '[EARN_DBG][RESULT]',
                        'orderId=', orderId,
                        'dispatchId=', dispatchId,
                        'userId=', userId,
                        'calculated=', calculated,
                    );
                }

                // ✅ 炸单（gross<0）：不抽成
                let multiplier = 1;
                if (!(grossRmb !== null && grossRmb < 0)) {
                    multiplier = this.resolveMultiplier(order, p, {
                        orderCutRaw,
                        projectCutRaw,
                        staffCutMap,
                    });
                }

                const calculated1 = roundMix1(calculated);
                const final1 = roundMix1(calculated1 * multiplier);
                const manualAdj1 = roundMix1(final1 - calculated1);
                const club1 = roundMix1(calculated1 - final1);

                const found = baseMap.get(userId);

                let settlementId: number;
                let settlementFinal: number;

                if (!found) {
                    const created = await tx.orderSettlement.create({
                        data: {
                            orderId,
                            dispatchId,
                            userId,
                            settlementType: baseSettlementType,
                            settlementBatchId,

                            calculatedEarnings: calculated1,
                            manualAdjustment: manualAdj1,
                            finalEarnings: final1,
                            clubEarnings: club1,

                            csEarnings: null,
                            inviteEarnings: null,
                            paymentStatus: PaymentStatus.UNPAID,
                        },
                        select: {id: true, finalEarnings: true},
                    });

                    settlementId = created.id;
                    settlementFinal = Number(created.finalEarnings ?? 0) as any;
                } else {
                    const updated = await tx.orderSettlement.update({
                        where: {id: found.id},
                        data: {
                            settlementBatchId,

                            calculatedEarnings: calculated1,
                            manualAdjustment: manualAdj1,
                            finalEarnings: final1,
                            clubEarnings: club1,
                        },
                        select: {id: true, finalEarnings: true},
                    });

                    settlementId = updated.id;
                    settlementFinal = Number(updated.finalEarnings ?? 0) as any;
                }

                // ✅ 钱包同步：负收益会写 direction=OUT（你贴的钱包方法已支持）
                if (allowWalletSync) {
                    await this.wallet.syncSettlementEarningByFinalEarnings(
                        {
                            userId,
                            finalEarnings: settlementFinal,
                            unlockAt,
                            sourceType: 'ORDER_SETTLEMENT',
                            bizType:
                                grossRmb !== null && grossRmb < 0
                                    ? WalletBizType.SETTLEMENT_BOMB_LOSS
                                    : WalletBizType.SETTLEMENT_EARNING_BASE,
                            sourceId: settlementId,
                            orderId,
                            dispatchId,
                            settlementId,
                        },
                        tx,
                    );
                }
            }),
        );

        // ===========================
        // 5.9 炸单池补偿（仅非小时单 + grossRmb>0 + repayRmb>0）
        // ===========================
        if (grossRmb !== null && repayRmb > 0) {
            const n = participants.length;
            const avg = roundMix1(repayRmb / n);

            const existingComp = await tx.orderSettlement.findMany({
                where: {
                    dispatchId,
                    settlementType: 'CARRY_COMPENSATION',
                    userId: {in: userIds},
                },
                select: {id: true, userId: true},
            });
            const compMap = new Map<number, { id: number }>();
            for (const e of existingComp) compMap.set(e.userId, e);

            for (let idx = 0; idx < n; idx++) {
                const p = participants[idx];
                const userId = (p as any).userId;

                let calculated = avg;
                if (idx === n - 1) {
                    const sumBeforeLast = roundMix1(avg * (n - 1));
                    calculated = roundMix1(repayRmb - sumBeforeLast);
                }

                const calculated1 = roundMix1(calculated);
                const final1 = calculated1;

                const found = compMap.get(userId);

                let settlementId: number;
                let settlementFinal: number;

                if (!found) {
                    const created = await tx.orderSettlement.create({
                        data: {
                            orderId,
                            dispatchId,
                            userId,
                            settlementType: 'CARRY_COMPENSATION',
                            settlementBatchId,

                            calculatedEarnings: calculated1,
                            manualAdjustment: 0,
                            finalEarnings: final1,
                            clubEarnings: 0,

                            csEarnings: null,
                            inviteEarnings: null,
                            paymentStatus: PaymentStatus.UNPAID,
                        },
                        select: {id: true, finalEarnings: true},
                    });

                    settlementId = created.id;
                    settlementFinal = Number(created.finalEarnings ?? 0) as any;
                } else {
                    const updated = await tx.orderSettlement.update({
                        where: {id: found.id},
                        data: {
                            settlementBatchId,
                            calculatedEarnings: calculated1,
                            manualAdjustment: 0,
                            finalEarnings: final1,
                            clubEarnings: 0,
                        },
                        select: {id: true, finalEarnings: true},
                    });

                    settlementId = updated.id;
                    settlementFinal = Number(updated.finalEarnings ?? 0) as any;
                }

                if (allowWalletSync) {
                    await this.wallet.syncSettlementEarningByFinalEarnings(
                        {
                            userId,
                            finalEarnings: settlementFinal,
                            unlockAt,
                            sourceType: 'ORDER_SETTLEMENT',
                            bizType: WalletBizType.SETTLEMENT_EARNING_CARRY,
                            sourceId: settlementId,
                            orderId,
                            dispatchId,
                            settlementId,
                        },
                        tx,
                    );
                }
            }
        }

        // ===========================
        // 6️⃣ 客服分红（仅 COMPLETE 写入）
        // ✅ 规则修复：体验单/福袋单不参与客服抽成
        const orderTypeForCs: any = ((order as any).projectSnapshot as any)?.type ?? ((order as any).project as any)?.type;
        const isCsExcluded =
            orderTypeForCs === OrderType.EXPERIENCE || orderTypeForCs === (OrderType as any).LUCKY_BAG;

        // ===========================
        if (!isCsExcluded && mode === 'COMPLETE' && CUSTOMER_SERVICE_SHARE_RATE > 0 && order.dispatcherId) {
            const csAmount = roundMix1((order.paidAmount ?? 0) * CUSTOMER_SERVICE_SHARE_RATE);
            if (csAmount > 0) {
                const csFound = await tx.orderSettlement.findUnique({
                    where: {
                        dispatchId_userId_settlementType: {
                            dispatchId,
                            userId: order.dispatcherId,
                            settlementType: 'CUSTOMER_SERVICE',
                        },
                    },
                    select: {id: true},
                });

                let csId: number;
                let csFinal: number;

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
                            clubEarnings: 0,
                            csEarnings: null,
                            inviteEarnings: null,
                            paymentStatus: PaymentStatus.UNPAID,
                        },
                        select: {id: true, finalEarnings: true},
                    });
                    csId = created.id;
                    csFinal = Number(created.finalEarnings ?? 0) as any;
                } else {
                    const updated = await tx.orderSettlement.update({
                        where: {id: csFound.id},
                        data: {
                            settlementBatchId,
                            calculatedEarnings: csAmount,
                            manualAdjustment: 0,
                            finalEarnings: csAmount,
                            clubEarnings: 0,
                        },
                        select: {id: true, finalEarnings: true},
                    });
                    csId = updated.id;
                    csFinal = Number(updated.finalEarnings ?? 0) as any;
                }

                if (allowWalletSync) {
                    await this.wallet.syncSettlementEarningByFinalEarnings(
                        {
                            userId: order.dispatcherId,
                            finalEarnings: csFinal,
                            unlockAt,
                            sourceType: 'ORDER_SETTLEMENT',
                            bizType: WalletBizType.SETTLEMENT_EARNING_CS,
                            sourceId: csId,
                            orderId,
                            dispatchId,
                            settlementId: csId,
                        },
                        tx,
                    );
                }
            }
        }

        // ===========================
        // 7️⃣ 聚合回写订单
        // ===========================
        const agg = await tx.orderSettlement.aggregate({
            where: {orderId},
            _sum: {finalEarnings: true, clubEarnings: true},
        });

        await tx.order.update({
            where: {id: orderId},
            data: {
                totalPlayerEarnings: roundMix1(Number(agg._sum.finalEarnings ?? 0)),
                clubEarnings: roundMix1(Number(agg._sum.clubEarnings ?? 0)),
            },
        });

        // ===========================
        // 8️⃣ 操作日志（记录关键追溯字段）
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
                staffCutHint: !isSet(orderCutRaw) && !isSet(projectCutRaw) ? 'STAFF_RATING_RATE' : null,

                billingMode,
                rateWanPerYuan,
                dispatchProgressWan: hasAnyProgressInput ? dispatchProgressWan : null,
                grossRmb,

                carryDebt,
                carryPaid,
                carryRemaining,
                repayRmb,
                normalGrossRmb,
                remainingPaidPool,
                excessNormalRmb,
            },
            tx,
        );

        return true;
    }

    /** -----------------------------
     * 分钟 -> 计费小时（的规则）
     * -ToDo 改造结算明细和小时单落库后将废弃
     * - 整数小时正常计
     * - 余分钟：<15=0, 15~45=0.5, >45=1
     * - totalMinutes < 15 => 0
     * -----------------------------*/
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

    /** -----------------------------
     * 订单结算中（存在 SETTLING 轮次）禁止某些操作（补收/重算/钱包对齐）
     * - 只负责抛错，不做状态修改
     * -----------------------------*/
    private async assertOrderNotSettlingOrThrow(
        tx: any,
        orderId: number,
        message = '订单正在结算处理中，请稍后再试',
    ) {
        const settlingCount = await tx.orderDispatch.count({
            where: {orderId, status: DispatchStatus.SETTLING as any},
        });
        if (settlingCount > 0) {
            // ✅ 这类属于并发冲突，用 409 更合理（不是 403）
            throw new ConflictException(message);
        }
    }

    /** -----------------------------
     *  读取 billingMode：快照优先，其次 project.billingMode
     * -----------------------------*/
    private getBillingModeFromOrder(order: any): BillingMode | undefined {
        const snapshot: any = order?.projectSnapshot || {};
        return (snapshot.billingMode as any) || (order?.project?.billingMode as any);
    }

    /** -----------------------------
     *  便捷函数 Todo 确认其功能并补充注释
     * -----------------------------*/
    private ensureDispatchStatus(dispatch: { status: DispatchStatus }, allowed: DispatchStatus[], message: string) {
        const allow = new Set<DispatchStatus>(allowed);
        if (!allow.has(dispatch.status)) throw new BadRequestException(message);
    }

    /** -----------------------------
     *  Todo 确认其功能并补充注释
     * -----------------------------*/
    private async getDispatchWithParticipants(dispatchId: number) {
        return this.prisma.orderDispatch.findUnique({
            where: {id: dispatchId},
            include: {
                participants: {include: {user: {select: {id: true, name: true, phone: true}}}},
                order: {select: {id: true, autoSerial: true, status: true}},
            },
        });
    }

    /**
     * ✅ 计算单个陪玩理论收益（保守版）
     * ToDo 计算相关收益公共方法
     * 说明：
     * - 项目真实收益规则可能更复杂（等级/类型/抽成/补收/超时/平台扣点等）
     * - 这里先提供最小实现，让编译通过，并保持“可替换点集中”
     */
    private calcPlayerEarning(params: {
        order: { paidAmount: number };
        participantsCount: number;
        ratio?: number;
        _dbg?: { orderId?: number; dispatchId?: number; userId?: number };
    }) {
        const {order, participantsCount, ratio, _dbg} = params;

        const paid = Number(order?.paidAmount || 0);
        const count = Math.max(1, Number(participantsCount || 1));

        // ✅ ratioMap 里 ratio 的语义是“份额 share（总和=1）”
        // - 有 ratio：直接按份额分摊 paid
        // - 无 ratio：默认均分 paid/count
        let baseShare: number;
        if (ratio !== null && ratio !== undefined) {
            const r = Number(ratio);
            baseShare = Number.isFinite(r) ? paid * r : paid / count;
        } else {
            baseShare = paid / count;
        }

        const out = roundMix1(baseShare);

        console.log(
            '[EARN_DBG][calcPlayerEarning]',
            'orderId=', _dbg?.orderId,
            'dispatchId=', _dbg?.dispatchId,
            'userId=', _dbg?.userId,
            'paid=', paid,
            'participantsCount=', participantsCount,
            'countUsed=', count,
            'ratio=', ratio,
            'baseShare=', baseShare,
            'out=roundMix1(baseShare)=', out,
        );

        return out;
    }

    /**
     * 计算到手 multiplier（优先级：订单抽成 > 项目抽成 > 陪玩抽成）
     *
     * 规则：
     * - 订单抽成：order.customClubRate（抽成比例 cut） => multiplier = 1 - cut
     *   ⚠️ order.clubRate 仅做历史快照展示，不参与规则计算
     * - 项目抽成：order.projectSnapshot.clubRate（优先）或 order.project.clubRate（抽成比例 cut） => multiplier = 1 - cut
     * - 陪玩抽成：staffRating.rate（抽成比例 cut） => multiplier = 1 - cut
     *
     * 口径兼容：
     * - 10 / 0.1 / 40 / 0.4 都可
     * - 0 也算“已设置”，只有 null/undefined 才算未设置
     *
     * 注意：
     * - 本方法不查 DB，只使用结算瞬间快照（避免结算过程中规则被改导致不一致）
     */
    private resolveMultiplier(
        order: any,
        participant: { userId: number },
        snapshot: {
            // ✅ 结算瞬间快照（只在 createSettlementsForDispatch 开头准备一次）
            orderCutRaw: any | null;     // order.customClubRate（可为 0）
            projectCutRaw: any | null;   // snapshot.clubRate 或 project.clubRate（可为 0）
            staffCutMap?: Map<number, number>; // staffRating.rate（抽成比例），仅当需要走员工评级时才会传
        },
    ): number {
        // ---------- normalize ----------
        const normalizeToRatio = (v: any, fallback: number) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            return n > 1 ? n / 100 : n; // 兼容 10 / 0.1 / 60 / 0.6
        };
        const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
        const isSet = (v: any) => v !== null && v !== undefined; // ✅ 0 也算已设置

        // ---------- 订单抽成（优先级最高） ----------
        // ✅ 订单固定抽成（平台抽成）
        // 口径：0 或 0.1 表示不抽成或抽 1 成，陪玩到手 = (1 - 0/0.1)
        if (isSet(snapshot.orderCutRaw)) {
            const cut = clamp01(normalizeToRatio(snapshot.orderCutRaw, 0));
            return clamp01(1 - cut);
        }

        // ---------- 项目抽成（快照优先） ----------
        // 项目固定抽成优先取快照，避免项目后改影响历史
        if (isSet(snapshot.projectCutRaw)) {
            const cut = clamp01(normalizeToRatio(snapshot.projectCutRaw, 0));
            return clamp01(1 - cut);
        }

        // ---------- 陪玩抽成（员工评级 staffRating.rate） ----------
        // 员工评级表 staffRating，对应抽成比例字段为 rate
        // ✅ 的业务定义：rate=0.4 表示抽 40%，陪玩到手 = 1 - 0.4 = 0.6
        const staffCut = snapshot.staffCutMap?.get(participant.userId);
        const cut = clamp01(normalizeToRatio(staffCut ?? 0, 0)); // 默认不抽成
        return clamp01(1 - cut);
    }

    /** ===========================
     *  ✅ Helpers（纯工具区域，不改变业务）应提到Utils的应尽快
     * ===========================*/
    /** -----------------------------
     *  解析 boolean：
     *  支持 boolean / number / string，
     *  避免 Boolean("false")===true 的坑
     * -----------------------------*/
    private parseBool(v: any, defaultValue: boolean) {
        if (v === undefined || v === null) return defaultValue;
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;

        if (typeof v === 'string') {
            const s = v.trim().toLowerCase();
            if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
            if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
        }

        return Boolean(v);
    }

    /** ✅ 截断到 1 位小数（不四舍五入）todo 确认功能是否与上面方法一致 */
    private trunc1(v: any): number {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;

        // 1位：乘10后截断再除10
        // 注意：Math.trunc 对负数也是“向0截断”，符合“舍弃”直觉
        return Math.trunc(n * 10) / 10;
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
     * ✅ 构建“进度比例”映射，用于存单（ARCHIVE）按贡献分摊
     *
     * 规则（保守版）：
     * - progress 取值范围建议 0~1（如果用 0~100，记得在这里除以 100）
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
            // ✅ 如果 progress 是 0~100（项目有可能），可改为：const w = raw != null ? raw / 100 : 1;
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
}
