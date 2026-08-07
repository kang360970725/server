/**
 * 计算结算冻结起止时间
 * - 冻结起点：COMPLETED dispatch.completedAt
 * - 冻结时长：根据 OrderType 与配置（体验/福袋默认 3 天，其他默认 7 天）
 */
export function computeSettlementFreezeTime(params: {
    order: any;
    freezeDaysConfig?: {
        experienceDays?: number;
        regularDays?: number;
    };
}): {
    freezeStartAt: Date;
    freezeEndAt: Date;
    freezeDays: number;
} {
    const { order } = params;
    const normalizeDays = (value: any, fallback: number) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) return fallback;
        return Math.floor(n);
    };
    const configuredExperienceDays = normalizeDays(params.freezeDaysConfig?.experienceDays, 3);
    const configuredRegularDays = normalizeDays(params.freezeDaysConfig?.regularDays, 7);

    if (!order) {
        throw new Error('order 不能为空');
    }

    const projectSnap = order.projectSnapshot;
    if (!projectSnap || !projectSnap.type) {
        throw new Error('订单缺少 projectSnapshot.type，无法计算冻结时间');
    }

    // 1️⃣ 找到 COMPLETED 的 dispatch（历史修复只认这个）
    //考虑历史数据BUG，可能没有时间，取派单时间
    const completedDispatch = (order.dispatches || []).find(
        (d: any) => d.status === 'COMPLETED' && (d.completedAt || d.acceptedAllAt),
    );


    let freezeStartAt = undefined;
    if (completedDispatch) freezeStartAt = new Date(completedDispatch.completedAt || completedDispatch.acceptedAllAt)

    // 2️⃣ 冻结天数判定（集中规则）
    let freezeDays = configuredRegularDays;

    switch (projectSnap.type) {
        case 'EXPERIENCE':
        case 'LUCKY_BAG':
            freezeDays = configuredExperienceDays;
            break;
        default:
            freezeDays = configuredRegularDays;
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
