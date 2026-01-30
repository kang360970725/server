/**
 * 计算结算冻结起止时间
 * - 冻结起点：COMPLETED dispatch.completedAt
 * - 冻结时长：根据 OrderType（3 / 7 天）
 */
export function computeSettlementFreezeTime(params: {
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
    //考虑历史数据BUG，可能没有时间，取派单时间
    const completedDispatch = (order.dispatches || []).find(
        (d: any) => d.status === 'COMPLETED' && (d.completedAt || d.acceptedAllAt),
    );


    let freezeStartAt = undefined;
    if (completedDispatch) freezeStartAt = new Date(completedDispatch.completedAt || completedDispatch.acceptedAllAt)

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
