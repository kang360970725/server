// src/utils/finance/generateRepairPlan.ts

type ExistingSettlement = {
    id: number;
    dispatchId: number;
    userId: number;
    user?: { id: number; name?: string };
    settlementType: string;
    calculatedEarnings?: any;
    manualAdjustment?: any;
    finalEarnings?: any;
    paymentStatus?: string;
    clubEarnings?: any;
    csEarnings?: any;
    inviteEarnings?: any;
};

type SettlementToCreate = {
    orderId: number;
    dispatchId: number;
    userId: number;
    settlementType: string;
    calculatedEarnings: any;
    manualAdjustment: any;
    finalEarnings: any;
};
//
// 可选：用于补齐 dispatchRound / dispatchStatus / isActive（让 plan 更贴近你之前的结构）
type DispatchMeta = {
    id: number;                 // dispatchId
    round?: number;             // dispatchRound
    status?: string;            // dispatchStatus
    // 如果你有参与者维度 isActive，未来可以扩展到 participantMetaMap
};
//
const toNum = (v: any, fallback = 0) => {
    const n = typeof v === 'string' ? Number(v) : Number(v);
    return Number.isFinite(n) ? n : fallback;
};

const keyOf = (x: { dispatchId: any; userId: any; settlementType: any }) =>
    `${String(x.dispatchId)}|${String(x.userId)}|${String(x.settlementType || '')}`;


// ✅ 说明（只一句）：保留你现有“plan item / preview / note / 排序”的生成逻辑不变
// ✅ 仅在末尾把 plan 组装成“轮次 -> 参与人一行 -> settlementType 列(缺失为 null 显示—) + 总览summary”的 ViewModel

type CompareSummary = {
    income?: number;
    payout: number;
    penaltyIncome: number;
    platformNet?: number;
};

type SettlementCell = {
    settlementType: string;
    note: string | null;
    preview: any; // 保持你已有 preview 字段，不额外约束
};

type CompareViewModel = {
    summary: CompareSummary;
    columns: Array<{ settlementType: string; title?: string }>;
    rounds: Array<{
        dispatchId: number;
        dispatchRound?: number;
        dispatchStatus?: string;

        roundSummary: { payout: number; penaltyIncome: number; net: number };

        rows: Array<{
            userId: number;
            user?: { id: number; name: string };

            // ✅ 全单统一列；缺失用 null（前端显示 —）
            cellsByType: Record<string, SettlementCell | null>;

            rowSummary: { payout: number; penaltyIncome: number; net: number };
        }>;
    }>;
};

export const compareSettlementsToPlan = (params: {
    existingSettlements: ExistingSettlement[];
    settlementsToCreate: SettlementToCreate[];
    dispatches?: DispatchMeta[]; // 可选
    epsilon?: number;
}) =>
{
    const { existingSettlements, settlementsToCreate, dispatches, epsilon = 1e-9 } = params;

    const existMap = new Map<string, ExistingSettlement>();
    for (const s of existingSettlements || []) existMap.set(keyOf(s), s);

    const expMap = new Map<string, SettlementToCreate>();
    for (const s of settlementsToCreate || []) expMap.set(keyOf(s), s);

    const dispatchMetaMap = new Map<number, DispatchMeta>();
    for (const d of dispatches || []) {
        if (d?.id) dispatchMetaMap.set(d.id, d);
    }

    const keys = new Set<string>([...existMap.keys(), ...expMap.keys()]);
    const plan: any[] = [];

    for (const k of keys) {
        const oldS = existMap.get(k);
        const newS = expMap.get(k);

        const dispatchId = (newS?.dispatchId ?? oldS?.dispatchId) as number;
        const userId = (newS?.userId ?? oldS?.userId) as number;
        const settlementType = String(newS?.settlementType ?? oldS?.settlementType ?? '');

        const meta = dispatchMetaMap.get(dispatchId);

        // old（库里）
        const oldCalculated = oldS ? toNum(oldS.calculatedEarnings, 0) : 0;
        const oldManualAdj = oldS ? toNum(oldS.manualAdjustment, 0) : 0;
        const oldFinal = oldS ? toNum(oldS.finalEarnings, 0) : 0;

        // expected（本次重算）
        const expectedCalculated = newS ? toNum(newS.calculatedEarnings, 0) : 0;
        const expectedManualAdj = newS ? toNum(newS.manualAdjustment, 0) : 0;
        const expectedFinal = newS ? toNum(newS.finalEarnings, 0) : 0;

        const delta = expectedFinal - oldFinal;
        const deltaFinal = Math.abs(delta) < epsilon ? 0 : delta;

        let note: string | null = null;
        if (oldS && newS) {
            if (deltaFinal === 0 && Math.abs(expectedManualAdj - oldManualAdj) < epsilon) {
                note = null;
            } else if (deltaFinal === 0) {
                note = '收益不变，但人工调整字段发生变化';
            } else {
                note = null;
            }
        } else if (!oldS && newS) {
            note = '本次重算新增结算记录（CREATE）';
        } else if (oldS && !newS) {
            note = '本次重算不再需要该结算记录（DELETE/覆盖）';
        }

        const item: any = {
            dispatchId,
            dispatchRound: meta?.round ?? undefined,
            dispatchStatus: meta?.status ?? undefined,

            userId,
            user: oldS?.user ? { id: oldS.user.id, name: oldS.user.name } : undefined,

            settlementType,

            preview: {
                dispatchId,
                dispatchRound: meta?.round ?? undefined,
                dispatchStatus: meta?.status ?? undefined,
                userId,
                settlementType,

                settlementId: oldS?.id ?? null,

                oldFinal,
                manualAdj: oldManualAdj,
                expectedCalculated,
                expectedFinal,
                deltaFinal,

                oldCalculated,
                expectedManualAdj,
            },

            note,
        };

        plan.push(item);
    }

    // 排序：dispatchRound优先（有则用），否则 dispatchId；再 userId/settlementType
    plan.sort((a, b) => {
        const ar = Number(a.dispatchRound ?? 1e9);
        const br = Number(b.dispatchRound ?? 1e9);
        if (ar !== br) return ar - br;
        if (a.dispatchId !== b.dispatchId) return a.dispatchId - b.dispatchId;
        if (a.userId !== b.userId) return a.userId - b.userId;
        return String(a.settlementType).localeCompare(String(b.settlementType));
    });

    // =========================================================
    // ✅ 以下：只做“分类处理”，输出一个结构满足：图二 + 图三 + 单元格图一细节
    // =========================================================

    const to2 = (n: number) => Math.round(n * 100) / 100;

    // 1) 全单统一列（A）
    const typeSet = new Set<string>();
    for (const it of plan) typeSet.add(String(it.settlementType ?? ''));
    const columns = Array.from(typeSet)
        .filter((t) => t !== '')
        .sort((a, b) => String(a).localeCompare(String(b)))
        .map((t) => ({ settlementType: t }));

    const allTypes = columns.map((c) => c.settlementType);

    // 2) 顶部总览（图三）
    let totalPayout = 0;
    let totalPenaltyIncome = 0;

    for (const it of plan) {
        const v = Number(it?.preview?.expectedFinal ?? 0);
        if (!Number.isFinite(v)) continue;

        // ✅ 你已确认：负数必然是炸单贡献收益（不看 settlementType）
        if (v > 0) totalPayout += v;
        else if (v < 0) totalPenaltyIncome += Math.abs(v);
    }

    const paidAmount =
        (params as any)?.paidAmount ??
        (params as any)?.orderSummary?.paidAmount ??
        undefined;

    const summary: CompareSummary = {
        payout: to2(totalPayout),
        penaltyIncome: to2(totalPenaltyIncome),
    };

    if (paidAmount !== undefined && Number.isFinite(Number(paidAmount))) {
        const income = Number(paidAmount);
        summary.income = to2(income);
        summary.platformNet = to2(income - totalPayout + totalPenaltyIncome);
    }

    // 3) rounds：按轮次分组 -> round 内按参与人一行 -> cellsByType 占位 null
    const roundMap = new Map<string, any>();

    const roundKeyOf = (it: any) =>
        `${it.dispatchRound ?? 'NA'}|${it.dispatchId ?? 'NA'}|${it.dispatchStatus ?? 'NA'}`;

    for (const it of plan) {
        const rKey = roundKeyOf(it);
        if (!roundMap.has(rKey)) {
            roundMap.set(rKey, {
                dispatchId: it.dispatchId,
                dispatchRound: it.dispatchRound,
                dispatchStatus: it.dispatchStatus,
                rowsMap: new Map<number, any>(),
                payout: 0,
                penaltyIncome: 0,
            });
        }
        const round = roundMap.get(rKey);

        // round 小计：用 expectedFinal（负数=炸单贡献）
        const ev = Number(it?.preview?.expectedFinal ?? 0);
        if (Number.isFinite(ev)) {
            if (ev > 0) round.payout += ev;
            else if (ev < 0) round.penaltyIncome += Math.abs(ev);
        }

        const uid = Number(it.userId);
        if (!round.rowsMap.has(uid)) {
            // 初始化 cellsByType：全单统一列，占位 null（前端显示 —）
            const initCells: Record<string, SettlementCell | null> = {};
            for (const t of allTypes) initCells[t] = null;

            round.rowsMap.set(uid, {
                userId: uid,
                user: it.user,
                cellsByType: initCells,
                payout: 0,
                penaltyIncome: 0,
            });
        }

        const row = round.rowsMap.get(uid);

        // 行小计
        if (Number.isFinite(ev)) {
            if (ev > 0) row.payout += ev;
            else if (ev < 0) row.penaltyIncome += Math.abs(ev);
        }

        // 填充 cell
        const st = String(it.settlementType ?? '');
        if (st) {
            row.cellsByType[st] = {
                settlementType: st,
                note: it.note ?? null,
                preview: it.preview, // ✅ 图一细节复用
            };
        }

        // user 兜底：如果该条没有 user（例如 CREATE 场景），尽量保留已有的
        if (!row.user && it.user) row.user = it.user;
    }

    // 输出 rounds（保持你原来的轮次排序逻辑：dispatchRound -> dispatchId）
    const rounds = Array.from(roundMap.values())
        .map((r) => {
            const rows = Array.from(r.rowsMap.values())
                .map((row: any) => ({
                    userId: row.userId,
                    user: row.user,
                    cellsByType: row.cellsByType,
                    rowSummary: {
                        payout: to2(row.payout),
                        penaltyIncome: to2(row.penaltyIncome),
                        net: to2(row.payout - row.penaltyIncome),
                    },
                }))
                .sort((a, b) => a.userId - b.userId);

            return {
                dispatchId: r.dispatchId,
                dispatchRound: r.dispatchRound,
                dispatchStatus: r.dispatchStatus,
                roundSummary: {
                    payout: to2(r.payout),
                    penaltyIncome: to2(r.penaltyIncome),
                    net: to2(r.payout - r.penaltyIncome),
                },
                rows,
            };
        })
        .sort((a, b) => {
            const ar = Number(a.dispatchRound ?? 1e9);
            const br = Number(b.dispatchRound ?? 1e9);
            if (ar !== br) return ar - br;
            return Number(a.dispatchId) - Number(b.dispatchId);
        });

    const viewModel: CompareViewModel = {
        summary,
        columns,
        rounds,
    };

    return viewModel;
};

/**
 * 计算结算冻结起止时间
 * - 冻结起点：COMPLETED dispatch.completedAt
 * - 冻结时长：根据 OrderType（3 / 7 天）
 */
function computeSettlementFreezeTime(params: {
    order: any;
}): {
    freezeStartAt: Date;
    freezeEndAt: Date;
    freezeDays: number;
} {
    const { order } = params;

    if (!order) {
        throw new Error('order 不能为空');
    }

    const projectSnap = order.projectSnapshot;
    if (!projectSnap || !projectSnap.type) {
        throw new Error('订单缺少 projectSnapshot.type，无法计算冻结时间');
    }

    // 1️⃣ 找到 COMPLETED 的 dispatch（历史修复只认这个）
    const completedDispatch = (order.dispatches || []).find(
        (d: any) => d.status === 'COMPLETED' && d.completedAt,
    );

    if (!completedDispatch) {
        throw new Error('未找到 status=COMPLETED 的派单轮次，无法计算冻结时间');
    }

    const freezeStartAt = new Date(completedDispatch.completedAt);

    // 2️⃣ 冻结天数判定（集中规则）
    let freezeDays = 7;

    switch (projectSnap.type) {
        case 'EXPERIENCE':
        case 'LUCKY_BAG':
            freezeDays = 3;
            break;
        default:
            freezeDays = 7;
            break;
    }

    // 3️⃣ 计算冻结结束时间
    const freezeEndAt = new Date(
        freezeStartAt.getTime() + freezeDays * 24 * 60 * 60 * 1000,
    );

    return {
        freezeStartAt,
        freezeEndAt,
        freezeDays,
    };
}
