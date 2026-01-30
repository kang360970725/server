// import {BadRequestException, ConflictException, Injectable, NotFoundException} from '@nestjs/common';
// import {PrismaService} from '../prisma/prisma.service';
// import {CreateOrderDto} from './dto/create-order.dto';
// import {QueryOrdersDto} from './dto/query-orders.dto';
// import {AssignDispatchDto} from './dto/assign-dispatch.dto';
// import {AcceptDispatchDto} from './dto/accept-dispatch.dto';
// import {ArchiveDispatchDto} from './dto/archive-dispatch.dto';
// import {CompleteDispatchDto} from './dto/complete-dispatch.dto';
// import {QuerySettlementBatchDto} from './dto/query-settlement-batch.dto';
// import {MarkPaidDto} from './dto/mark-paid.dto';
// import {
//     BillingMode,
//     DispatchStatus,
//     OrderStatus,
//     OrderType,
//     PaymentStatus,
//     PlayerWorkStatus,
//     WalletBizType,
//     WalletDirection
// } from '@prisma/client';
// import {WalletService} from '../wallet/wallet.service';
// import {randomUUID} from 'crypto';
//
// /**
//  * OrdersService v0.1
//  *
//  * 关键业务约束（v0.1）：
//  * 1) 金额字段（应收/实付）创建后不可修改 —— v0.1 暂不提供 update 接口
//  * 2) 派单参与者只能在 dispatch.status=WAIT_ASSIGN 时修改
//  * 3) “已接单”= 本轮所有参与者 acceptedAt 都非空
//  * 4) 存单/结单会为本轮生成结算明细（OrderSettlement 落库）
//  *    - 存单：按进度比例计算本轮应结收益（保底单/小时单）
//  *    - 结单：结算“剩余部分”或“全量”（小时单默认全量；保底单默认结剩余）
//  * 5) 小时单时长计算：
//  *    - 计时区间：acceptedAllAt -> archivedAt/completedAt
//  *    - 扣除 deductMinutesValue
//  *    - 折算规则：整数小时 + 分钟段(0/0.5/1)，分钟 <15=0, 15~45=0.5, >45=1
//  */
// @Injectable()
// export class OrdersService {
//     constructor(
//         private prisma: PrismaService,
//         private wallet: WalletService,
//     ) {}
//
//
//
//     // -----------------------------
//     // 3) 派单/更新参与者
//     // -----------------------------
//
//     /**
//      * 派单策略（v0.1）：
//      * - 如果订单没有 currentDispatch：创建 round=1 的 dispatch（WAIT_ASSIGN -> WAIT_ACCEPT）
//      * - 如果有 currentDispatch 且 status=WAIT_ASSIGN：允许更新参与者
//      * - 如果 currentDispatch 不是 WAIT_ASSIGN：不允许修改参与者
//      */
//     async assignOrUpdateDispatch(orderId: number, dto: AssignDispatchDto, operatorId: number) {
//         const order = await this.prisma.order.findUnique({
//             where: {id: orderId},
//             include: {currentDispatch: true, project: true},
//         });
//         if (!order) throw new NotFoundException('订单不存在');
//
//         // 若已退款等终态，可禁用派单（后续可按业务扩展）
//         if (order.status === OrderStatus.REFUNDED) {
//             throw new BadRequestException('已退款订单不可派单');
//         }
//
//         // 如果有 currentDispatch
//         if (order.currentDispatchId) {
//             const dispatch = await this.prisma.orderDispatch.findUnique({
//                 where: {id: order.currentDispatchId},
//                 include: {participants: true},
//             });
//             if (!dispatch) throw new NotFoundException('当前派单批次不存在');
//
//             if (dispatch.status !== DispatchStatus.WAIT_ASSIGN) {
//                 throw new BadRequestException('当前状态不可修改参与者（仅待派单可修改）');
//             }
//
//             // 更新参与者：简单策略 = 删除后重建（仅 WAIT_ASSIGN 阶段，没有历史价值）
//             await this.prisma.orderParticipant.deleteMany({where: {dispatchId: dispatch.id}});
//             await this.prisma.orderParticipant.createMany({
//                 data: dto.playerIds.map((uid) => ({
//                     dispatchId: dispatch.id,
//                     userId: uid,
//                     acceptedAt: null,
//                     contributionAmount: 0,
//                     progressBaseWan: null,
//                     isActive: true,
//                 })),
//             });
//
//             // 将派单状态推进到 WAIT_ACCEPT（表示已经指派了人）
//             const updatedDispatch = await this.prisma.orderDispatch.update({
//                 where: {id: dispatch.id},
//                 data: {
//                     status: DispatchStatus.WAIT_ACCEPT,
//                     assignedAt: new Date(),
//                     remark: dto.remark ?? dispatch.remark ?? null,
//                 },
//                 include: {
//                     participants: {include: {user: {select: {id: true, name: true, phone: true}}}},
//                 },
//             });
//
//             const updatedOrder = await this.prisma.order.update({
//                 where: {id: order.id},
//                 data: {
//                     status: OrderStatus.WAIT_ACCEPT,
//                 },
//             });
//
//             await this.logOrderAction(operatorId, order.id, 'ASSIGN_DISPATCH', {
//                 dispatchId: updatedDispatch.id,
//                 players: dto.playerIds,
//             });
//
//             return {order: updatedOrder, dispatch: updatedDispatch};
//         }
//
//         // 如果没有 currentDispatch：创建 round=1
//         const lastDispatch = await this.prisma.orderDispatch.findFirst({
//             where: {orderId},
//             orderBy: {round: 'desc'},
//             select: {round: true},
//         });
//         const round = (lastDispatch?.round ?? 0) + 1;
//
//         const dispatch = await this.prisma.orderDispatch.create({
//             data: {
//                 orderId,
//                 round,
//                 status: DispatchStatus.WAIT_ACCEPT,
//                 assignedAt: new Date(),
//                 remark: dto.remark ?? null,
//                 participants: {
//                     create: dto.playerIds.map((uid) => ({
//                         userId: uid,
//                         isActive: true,
//                     })),
//                 },
//             },
//             include: {
//                 participants: {include: {user: {select: {id: true, name: true, phone: true}}}},
//             },
//         });
//
//         await this.prisma.order.update({
//             where: {id: orderId},
//             data: {
//                 currentDispatchId: dispatch.id,
//                 status: OrderStatus.WAIT_ACCEPT,
//             },
//         });
//
//         await this.logOrderAction(operatorId, orderId, 'CREATE_DISPATCH', {
//             dispatchId: dispatch.id,
//             round,
//             players: dto.playerIds,
//         });
//
//         return dispatch;
//     }
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//     private capProgress(progress: number, base: number): number {
//         if (progress > base) return base;
//         if (progress < -base) return -base;
//         return progress;
//     }
//
//     private async sumDispatchProgressWan(dispatchId: number): Promise<number> {
//         const parts = await this.prisma.orderParticipant.findMany({
//             where: {dispatchId},
//             select: {progressBaseWan: true},
//         });
//         return parts.reduce((sum, p) => sum + (p.progressBaseWan ?? 0), 0);
//     }
//
//     // -----------------------------
//     // 8) 批次结算查询 / 标记打款
//     // -----------------------------
//
//
//     // ==========================
//     // ✅ 重新核算入口（修复历史数据）
//     // - 仅重算 OrderSettlement（可选：是否同步钱包）
//     // - 默认不碰钱包：allowWalletSync=false（最安全）
//     // ==========================
//     async recalculateOrderSettlements(params: {
//         orderId: number;
//         operatorId: number;
//         scope?: 'COMPLETED_AND_ARCHIVED' | 'COMPLETED_ONLY' | 'ARCHIVED_ONLY';
//         allowWalletSync?: boolean;
//         reason?: string;
//     })
//     {
//         const orderId = Number(params.orderId);
//         const operatorId = Number(params.operatorId);
//         if (!orderId) throw new BadRequestException('orderId 必填');
//
//         const scope = params.scope ?? 'COMPLETED_AND_ARCHIVED';
//         const allowWalletSync = params.allowWalletSync === true; // 默认 false（修历史最安全）
//         const settlementBatchId = randomUUID();
//
//         return this.prisma.$transaction(async (tx) => {
//             // 防并发：结算中不允许重算
//             await this.assertOrderNotSettlingOrThrow(tx, orderId, '订单正在结算处理中，禁止重新核算');
//
//             const statusIn: any[] = [];
//             if (scope === 'COMPLETED_ONLY' || scope === 'COMPLETED_AND_ARCHIVED') statusIn.push(DispatchStatus.COMPLETED as any);
//             if (scope === 'ARCHIVED_ONLY' || scope === 'COMPLETED_AND_ARCHIVED') statusIn.push(DispatchStatus.ARCHIVED as any);
//
//             const dispatches = await tx.orderDispatch.findMany({
//                 where: { orderId, status: { in: statusIn } },
//                 select: { id: true, status: true },
//                 orderBy: { id: 'asc' },
//             });
//             if (dispatches.length === 0) {
//                 throw new ConflictException('未找到可重新核算的派单轮次（已结单/已存单）');
//             }
//
//             for (const d of dispatches) {
//                 const mode: 'ARCHIVE' | 'COMPLETE' = (d as any).status === (DispatchStatus as any).ARCHIVED ? 'ARCHIVE' : 'COMPLETE';
//                 await this.createSettlementsForDispatch(
//                     {
//                         orderId,
//                         dispatchId: d.id,
//                         mode,
//                         settlementBatchId,
//                         allowWalletSync,
//                     },
//                     tx,
//                 );
//             }
//
//             await this.writeUserLog(tx, {
//                 userId: operatorId,
//                 action: 'RECALC_ORDER_SETTLEMENTS',
//                 targetType: 'ORDER',
//                 targetId: orderId,
//                 oldData: { scope } as any,
//                 newData: { scope, allowWalletSync, settlementBatchId } as any,
//                 remark: params.reason ? `重新核算：${params.reason}，batch=${settlementBatchId}` : `重新核算，batch=${settlementBatchId}`,
//             });
//
//             return { orderId, scope, allowWalletSync, settlementBatchId, dispatchCount: dispatches.length };
//         });
//     }
//
//     /**
//      * ✅ 钱包对齐修复（以 settlement.finalEarnings 为准）
//      * - 默认只允许修复冻结中的收益（walletTx.status=FROZEN 且 hold.status=FROZEN）
//      * - 幂等：重复执行不会重复计入余额
//      * - dryRun=true：只返回差异，不落库
//      */
//     async repairWalletForOrderSettlements(params: {
//         orderId: number;
//         operatorId: number;
//         reason?: string;
//         dryRun?: boolean;
//         scope?: 'COMPLETED_AND_ARCHIVED' | 'COMPLETED_ONLY' | 'ARCHIVED_ONLY';
//     }) {
//         const { orderId, operatorId, reason, dryRun = false } = params;
//
//         return this.prisma.$transaction(async (tx) => {
//             // 1) 并发保护：结算中禁止钱包对齐（409）
//             await this.assertOrderNotSettlingOrThrow(tx, orderId, '订单正在结算处理中，禁止钱包对齐');
//
//             // 2) 找到要对齐的轮次（默认：COMPLETED + ARCHIVED）
//             const scope = params.scope ?? 'COMPLETED_AND_ARCHIVED';
//             const inStatuses =
//                 scope === 'COMPLETED_ONLY'
//                     ? [DispatchStatus.COMPLETED as any]
//                     : scope === 'ARCHIVED_ONLY'
//                     ? [DispatchStatus.ARCHIVED as any]
//                     : [DispatchStatus.COMPLETED as any, DispatchStatus.ARCHIVED as any];
//
//             // 3) 取所有结算记录（以 finalEarnings 为准；若 finalEarnings 为空用 calculatedEarnings 兜底）
//             const settlements = await tx.orderSettlement.findMany({
//                 where: {
//                     orderId,
//                     dispatch: { status: { in: inStatuses } } as any,
//                 } as any,
//                 select: {
//                     id: true,
//                     orderId: true,
//                     dispatchId: true,
//                     userId: true,
//                     finalEarnings: true,
//                     calculatedEarnings: true,
//                 },
//                 orderBy: [{ dispatchId: 'asc' }, { id: 'asc' }],
//             });
//
//             if (!settlements.length) {
//                 throw new BadRequestException('未找到需要对齐的钱包结算记录');
//             }
//
//             const batchId = randomUUID();
//             const diffs: any[] = [];
//             const blocked: any[] = [];
//             const repaired: any[] = [];
//
//             for (const s of settlements) {
//                 const expected = Number(s.finalEarnings ?? s.calculatedEarnings ?? 0);
//
//                 // settlement 收益 <=0 的策略：
//                 // - 你现有钱包规则可能允许负数即时扣款；为了不破坏旧行为，这里只做“记录差异”
//                 // - 真要修负数扣款，建议走“专用调整入口”（避免历史已入账被改）
//                 // 先按最安全：expected<=0 不自动修钱包，只记录。
//                 // if (expected <= 0) {
//                 //     diffs.push({
//                 //         settlementId: s.id,
//                 //         userId: s.userId,
//                 //         expected,
//                 //         note: 'expected<=0：默认不自动修钱包（仅记录差异）',
//                 //     });
//                 //     continue;
//                 // }
//
//                 // 4) 查找该 settlement 对应的钱包流水（唯一键：sourceType+sourceId）
//                 const earningTx = await tx.walletTransaction.findUnique({
//                     where: {
//                         sourceType_sourceId: {
//                             sourceType: 'ORDER_SETTLEMENT',
//                             sourceId: s.id,
//                         },
//                     },
//                     select: {
//                         id: true,
//                         userId: true,
//                         amount: true,
//                         status: true,
//                     },
//                 });
//
//                 // 5) 若已存在但不是冻结：禁止修（避免已入账/已解冻被改），记录 blocked
//                 if (earningTx && earningTx.status !== 'FROZEN') {
//                     blocked.push({
//                         settlementId: s.id,
//                         walletTxId: earningTx.id,
//                         status: earningTx.status,
//                         expected,
//                         current: Number(earningTx.amount ?? 0),
//                         reason: 'walletTx 非冻结状态，禁止对齐（请走专用冲正/调整流程）',
//                     });
//                     continue;
//                 }
//
//                 // 若存在 hold，也必须是冻结
//                 if (earningTx) {
//                     const hold = await tx.walletHold.findUnique({
//                         where: { earningTxId: earningTx.id },
//                         select: { id: true, status: true, unlockAt: true, amount: true },
//                     });
//                     if (hold && hold.status !== 'FROZEN') {
//                         blocked.push({
//                             settlementId: s.id,
//                             walletTxId: earningTx.id,
//                             holdId: hold.id,
//                             holdStatus: hold.status,
//                             expected,
//                             current: Number(earningTx.amount ?? 0),
//                             reason: 'hold 非冻结状态，禁止对齐',
//                         });
//                         continue;
//                     }
//
//                     const current = Number(earningTx.amount ?? 0);
//                     if (current === expected) {
//                         // 已对齐
//                         continue;
//                     }
//
//                     diffs.push({
//                         settlementId: s.id,
//                         walletTxId: earningTx.id,
//                         userId: s.userId,
//                         expected,
//                         current,
//                     });
//
//                     if (dryRun) continue;
//
//                     // 6) 关键：用 wallet 的“幂等同步方法”去修复（必须按 delta 调整余额，不得重复加钱）
//                     // ✅ 这一步我建议落到 WalletService：repairSettlementEarning(...)
//                     await this.wallet.repairSettlementEarning(
//                         {
//                             userId: s.userId,
//                             sourceType: 'ORDER_SETTLEMENT',
//                             sourceId: s.id,
//                             orderId: s.orderId,
//                             dispatchId: s.dispatchId ?? null,
//                             settlementId: s.id,
//                             expectedAmount: expected,
//                         },
//                         tx,
//                     );
//
//                     repaired.push({ settlementId: s.id, userId: s.userId, from: current, to: expected });
//                 } else {
//                     // 7) 缺失钱包流水：可补建（仍属于冻结收益，安全）
//                     diffs.push({
//                         settlementId: s.id,
//                         walletTxId: null,
//                         userId: s.userId,
//                         expected,
//                         current: 0,
//                         note: '缺失 walletTx：将补建冻结流水',
//                     });
//
//                     if (dryRun) continue;
//
//                     await this.wallet.repairSettlementEarning(
//                         {
//                             userId: s.userId,
//                             sourceType: 'ORDER_SETTLEMENT',
//                             sourceId: s.id,
//                             orderId: s.orderId,
//                             dispatchId: s.dispatchId ?? null,
//                             settlementId: s.id,
//                             expectedAmount: expected,
//                         },
//                         tx,
//                     );
//
//                     repaired.push({ settlementId: s.id, userId: s.userId, from: 0, to: expected });
//                 }
//             }
//
//             // 8) 写日志（不抛 403，blocked 会返回给前端）
//             await this.writeUserLog(tx, {
//                 userId: operatorId,
//                 action: 'REPAIR_WALLET_BY_SETTLEMENTS',
//                 targetType: 'ORDER',
//                 targetId: orderId,
//                 oldData: { batchId } as any,
//                 newData: {
//                     repairedCount: repaired.length,
//                     blockedCount: blocked.length,
//                     diffCount: diffs.length,
//                     dryRun,
//                     scope,
//                     reason: reason ?? null,
//                 } as any,
//                 remark: `钱包对齐修复（batch=${batchId}）${dryRun ? '[DRY_RUN]' : ''}`,
//             });
//
//             return { batchId, dryRun, diffs, repaired, blocked };
//         });
//     }
//
//
//
//
//
//     async querySettlementBatch(query: QuerySettlementBatchDto) {
//         const batchType = query.batchType ?? 'MONTHLY_REGULAR';
//
//         const start = query.periodStart ? new Date(query.periodStart) : this.defaultPeriodStart(batchType);
//         const end = query.periodEnd ? new Date(query.periodEnd) : this.defaultPeriodEnd(batchType, start);
//
//         const settlements = await this.prisma.orderSettlement.findMany({
//             where: {
//                 settledAt: {gte: start, lt: end},
//                 settlementType: batchType === 'EXPERIENCE_3DAY' ? 'EXPERIENCE' : 'REGULAR',
//             },
//             include: {
//                 user: {select: {id: true, name: true, phone: true}},
//                 order: {select: {id: true, paidAmount: true, clubEarnings: true}},
//             },
//         });
//
//         const totalIncome = settlements.reduce((sum, s) => sum + (s.order?.paidAmount ?? 0), 0);
//         const clubIncome = settlements.reduce((sum, s) => sum + (s.order?.clubEarnings ?? 0), 0);
//         const payableToPlayers = settlements.reduce(
//             (sum, s) => sum + Number((s as any).finalEarnings ?? 0),
//             0,
//         );
//
//         const map = new Map<number, any>();
//         for (const s of settlements) {
//             const uid = s.userId;
//             const cur =
//                 map.get(uid) ?? ({
//                     userId: uid,
//                     name: s.user?.name ?? '',
//                     phone: s.user?.phone ?? '',
//                     settlementType: s.settlementType,
//                     totalOrders: 0,
//                     totalEarnings: 0,
//                 } as any);
//             cur.totalOrders += 1;
//             cur.totalEarnings += s.finalEarnings ?? 0;
//             map.set(uid, cur);
//         }
//
//         return {
//             batchType,
//             periodStart: start,
//             periodEnd: end,
//             summary: {
//                 totalIncome,
//                 clubIncome,
//                 payableToPlayers,
//             },
//             players: Array.from(map.values()).sort((a, b) => b.totalEarnings - a.totalEarnings),
//         };
//     }
//
//     private defaultPeriodStart(batchType: string): Date {
//         const now = new Date();
//         if (batchType === 'EXPERIENCE_3DAY') {
//             const d = new Date(now);
//             d.setDate(d.getDate() - 3);
//             d.setHours(0, 0, 0, 0);
//             return d;
//         }
//
//         const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
//         return new Date(firstOfThisMonth.getFullYear(), firstOfThisMonth.getMonth() - 1, 1);
//     }
//
//     private defaultPeriodEnd(batchType: string, start: Date): Date {
//         if (batchType === 'EXPERIENCE_3DAY') {
//             const end = new Date(start);
//             end.setDate(end.getDate() + 3);
//             return end;
//         }
//         return new Date(start.getFullYear(), start.getMonth() + 1, 1);
//     }
//
//
//     // -----------------------------
//     // 9) 陪玩查询自己的记录
//     // -----------------------------
//
//     async listMyParticipations(userId: number) {
//         return this.prisma.orderParticipant.findMany({
//             where: {userId},
//             orderBy: {id: 'desc'},
//             include: {
//                 dispatch: {
//                     include: {
//                         order: {
//                             select: {
//                                 id: true,
//                                 autoSerial: true,
//                                 status: true,
//                                 paidAmount: true,
//                                 customerGameId: true,
//                                 createdAt: true,
//                             },
//                         },
//                     },
//                 },
//             },
//         });
//     }
//
//     async listMySettlements(userId: number) {
//         return this.prisma.orderSettlement.findMany({
//             where: {userId},
//             orderBy: {settledAt: 'desc'},
//             include: {
//                 order: {
//                     select: {
//                         id: true,
//                         autoSerial: true,
//                         paidAmount: true,
//                         status: true,
//                         customerGameId: true,
//                     },
//                 },
//                 dispatch: {
//                     select: {
//                         id: true,
//                         round: true,
//                         status: true,
//                         archivedAt: true,
//                         completedAt: true,
//                     },
//                 },
//             },
//         });
//     }
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
//
// }
