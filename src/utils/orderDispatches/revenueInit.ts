import {round2, roundMix1, toNum} from "../money/format";
import {DispatchStatus} from "@prisma/client";
import {BadRequestException} from "@nestjs/common";

const CUSTOMER_SERVICE_SHARE_RATE = 0.01;

const distributeRoundedMoney = (total: number, count: number) => {
    const safeTotal = Number(total) || 0;
    const safeCount = Math.max(1, Math.floor(Number(count) || 0));
    const base = roundMix1(safeTotal / safeCount);
    const items = Array.from({ length: safeCount }, (_, index) => {
        if (index === safeCount - 1) {
            return roundMix1(safeTotal - base * (safeCount - 1));
        }
        return base;
    });
    return items;
};

const getSettlementParticipants = (dispatch: any) => {
    return (dispatch?.participants ?? []).filter((p: any) => {
        const userId = Number(p?.userId ?? 0);
        if (!Number.isFinite(userId) || userId <= 0) return false;
        if (p?.rejectedAt) return false;
        return true;
    });
};

const sortSettlementParticipants = (participants: any[]) => {
    return [...(participants ?? [])].sort((a: any, b: any) => {
        const userDiff = Number(a?.userId ?? 0) - Number(b?.userId ?? 0);
        if (userDiff !== 0) return userDiff;
        return Number(a?.id ?? 0) - Number(b?.id ?? 0);
    });
};

const splitEvenlyWithResidual = (total: number, count: number) => {
    const safeTotal = roundMix1(Number(total) || 0);
    const safeCount = Math.max(1, Math.floor(Number(count) || 0));
    const base = roundMix1(safeTotal / safeCount);
    const residual = roundMix1(safeTotal - base * safeCount);
    return {base, residual};
};

const getSettlementBaseAmount = (order: any) => {
    const explicit = Number(order?.settlementBaseAmount ?? 0);
    if (Number.isFinite(explicit) && explicit > 0) return roundMix1(explicit);

    const paid = Number(order?.paidAmount ?? 0);
    if (Number.isFinite(paid) && paid > 0) return roundMix1(paid);

    const receivable = Number(order?.receivableAmount ?? 0);
    if (Number.isFinite(receivable) && receivable > 0) return roundMix1(receivable);

    const original = Number(order?.originalAmount ?? 0);
    if (Number.isFinite(original) && original > 0) return roundMix1(original);

    return 0;
};
export const calcBillableHours = (acceptedAt?: Date | null, endAt?: Date | null, deductMinutesValue?: number | null) => {
    if (!acceptedAt || !endAt) return 0;
    const diffMinutesRaw = Math.floor((+new Date(endAt) - +new Date(acceptedAt)) / 60000);
    const deduct = Number.isFinite(Number(deductMinutesValue)) ? Number(deductMinutesValue) : 0;
    const minutes = Math.max(0, diffMinutesRaw - deduct);

    const h = Math.floor(minutes / 60);
    const rem = minutes % 60;

    let remHours = 0;
    if (rem < 18) remHours = 0;
    else if (rem <= 45) remHours = 0.5;
    else remHours = 1;

    return roundMix1(h + remHours);
};

/**
 * 计算小时单应得收益：
 * - order：订单
 * - dispatches：派单记录
 * -
 */
export const computeBillingHours = (order: any) => {
    const settlements: any[] = [];
    const { orderQuantity, projectSnapshot } = order;

    const dispatches = [...(order.dispatches ?? [])].sort(
        (a, b) => (a.round ?? 0) - (b.round ?? 0),
    );

    const settlementBaseAmount = getSettlementBaseAmount(order);
    let lastPaidAmount = settlementBaseAmount;
    const orderPaidAmount = settlementBaseAmount;

    const orderMeanPrice = roundMix1(lastPaidAmount / orderQuantity);
    if (orderMeanPrice !== order.projectSnapshot?.price) {
        // todo: 存在手动折扣时，这里后续可扩展校验/记录
    }

    const unitPrice =
        orderMeanPrice > order.projectSnapshot?.price
            ? order.projectSnapshot?.price
            : orderMeanPrice;

    const includeCustomerServiceRate = order?.dispatcher?.userType === 'CUSTOMER_SERVICE';

    for (const d of dispatches) {
        const active = sortSettlementParticipants(getSettlementParticipants(d));
        const inactive = (d.participants ?? []).filter((p: any) => p.rejectedAt);

        if (!active.length) {
            throw new BadRequestException(`派单记录有误，无法完成核算`);
        }

        const endAt =
            d.status === DispatchStatus.COMPLETED ? d.completedAt : d.archivedAt;

        const acceptedAtMin = active
            .map((p: any) => p.acceptedAt)
            .filter(Boolean)
            .sort((a: any, b: any) => +new Date(a) - +new Date(b))[0] as
            | Date
            | undefined;

        const roundHours = Number.isFinite(toNum(d.billableHours))
            ? roundMix1(toNum(d.billableHours))
            : calcBillableHours(
                acceptedAtMin ?? null,
                endAt ?? null,
                d.deductMinutesValue ?? 0,
            );

        let thisMoney = 0;

        if (d.status === DispatchStatus.ARCHIVED) {
            thisMoney = roundMix1(roundHours * unitPrice);
            thisMoney = thisMoney <= lastPaidAmount ? thisMoney : lastPaidAmount;
            lastPaidAmount = roundMix1(lastPaidAmount - thisMoney);
        }

        if (d.status === DispatchStatus.COMPLETED) {
            thisMoney = roundMix1(lastPaidAmount * 1);

            // ✅ 客服收益：只在最终结单轮生成
            if (order?.dispatcher?.userType === 'CUSTOMER_SERVICE') {
                const csMoney = roundMix1(orderPaidAmount * 0.01);

                settlements.push({
                    orderId: order.id,
                    dispatchId: d.id,
                    userId: order.dispatcherId,
                    userName: order.dispatcher.name,
                    settlementType: 'CUSTOMER_SERVICE',
                    settlementBatchId: order.settlementBatchId,
                    calculatedEarnings: csMoney,
                    manualAdjustment: 0,
                    finalEarnings: csMoney,

                    // ✅ 业绩辅助字段
                    ownerRoleType: 'CS',
                    contributionBaseAmount: roundMix1(orderPaidAmount),
                    commissionRate: roundMix1(0.01),
                    grossPerformanceAmount: csMoney,
                    netIncomeAmount: csMoney,
                    clubEarnings: 0,
                    csEarnings: 0,
                    inviteEarnings: 0,
                });
            }
        }

        const rateSnapshots = active.map((p: any) => ({
            p,
            ...getPlayerRate(
                order.customClubRate,
                projectSnapshot?.clubRate,
                p.user?.staffRating?.rate,
                { includeCustomerServiceRate },
            ),
        }));
        const uniformRate = rateSnapshots.length > 0
            && rateSnapshots.every((item) => Math.abs(Number(item.playerRate ?? 0) - Number(rateSnapshots[0].playerRate ?? 0)) < 1e-9);

        if (d.status === DispatchStatus.COMPLETED) {
            lastPaidAmount = 0;
        }

        const uniformSplit = uniformRate ? splitEvenlyWithResidual(thisMoney, active.length) : null;

        for (const [idx, item] of rateSnapshots.entries()) {
            const p = item.p;
            const playerRate = Number(item.playerRate ?? 0);
            const commissionRate = roundMix1(item.commissionRate ?? 0);
            const perBaseYuan = uniformRate
                ? uniformSplit?.base ?? 0
                : distributeRoundedMoney(thisMoney, active.length)[idx] ?? 0;
            const expectedCalculated = uniformRate
                ? roundMix1(perBaseYuan * playerRate)
                : roundMix1(perBaseYuan * playerRate);
            const settlementType = order.settlementType ?? 'REGULAR';
            const clubEarnings = roundMix1(perBaseYuan - expectedCalculated + (uniformRate && idx === 0 ? (uniformSplit?.residual ?? 0) : 0));

            settlements.push({
                orderId: order.id,
                dispatchId: d.id,
                userId: p.userId,
                userName: p.user?.name,
                settlementType,
                settlementBatchId: order.settlementBatchId,
                calculatedEarnings: expectedCalculated,
                manualAdjustment: 0,
                finalEarnings: expectedCalculated,

                // ✅ 业绩辅助字段
                ownerRoleType: 'PLAYER',
                contributionBaseAmount: roundMix1(perBaseYuan),
                commissionRate,
                grossPerformanceAmount: roundMix1(perBaseYuan),
                netIncomeAmount: roundMix1(expectedCalculated),
                clubEarnings,
            });
        }
    }

    return settlements;
};
/**
 * 计算保底单应得收益：
 * - order：订单
 * - dispatches：派单记录
 * -
 */
export const computeBillingGuaranteed = (order: any) => {
    const settlements: any[] = [];
    const { status, baseAmountWan, projectSnapshot } = order;

    if (!['COMPLETED', 'COMPLETED_PENDING_CONFIRM'].includes(status)) {
        throw new BadRequestException(`订单状态异常，无法完成核算`);
    }

    const dispatches = [...(order.dispatches ?? [])].sort(
        (a, b) => (a.round ?? 0) - (b.round ?? 0),
    );

    const settlementBaseAmount = getSettlementBaseAmount(order);
    let lastPaidAmount = settlementBaseAmount || 0;
    const orderPaidAmount = settlementBaseAmount || 0;

    const orderRatio = lastPaidAmount > 0 ? Number(baseAmountWan) / lastPaidAmount : 0;
    const includeCustomerServiceRate = order?.dispatcher?.userType === 'CUSTOMER_SERVICE';

    for (const d of dispatches) {
        const active = sortSettlementParticipants(getSettlementParticipants(d));
        const inactive = (d.participants ?? []).filter((p: any) => p.rejectedAt);

        if (!active.length) {
            throw new BadRequestException(`派单记录有误，无法完成核算`);
        }

        // ✅ 客服收益：只在最终结单轮生成
        if (d.status === DispatchStatus.COMPLETED) {
            if (order?.dispatcher?.userType === 'CUSTOMER_SERVICE') {
                const csMoney = roundMix1(orderPaidAmount * 0.01);

                settlements.push({
                    orderId: order.id,
                    dispatchId: d.id,
                    userId: order.dispatcherId,
                    userName: order.dispatcher.name,
                    settlementType: 'CUSTOMER_SERVICE',
                    settlementBatchId: order.settlementBatchId,
                    calculatedEarnings: csMoney,
                    manualAdjustment: 0,
                    finalEarnings: csMoney,

                    ownerRoleType: 'CS',
                    contributionBaseAmount: roundMix1(orderPaidAmount),
                    commissionRate: roundMix1(0.01),
                    grossPerformanceAmount: csMoney,
                    netIncomeAmount: csMoney,
                    clubEarnings: 0,
                    csEarnings: 0,
                    inviteEarnings: 0,
                });
            }
        }

        const completedUniformSplit =
            d.status === DispatchStatus.COMPLETED ? splitEvenlyWithResidual(lastPaidAmount, active.length) : null;
        const archivedUniformSplit =
            d.status === DispatchStatus.ARCHIVED ? splitEvenlyWithResidual(0, active.length) : null;

        const rateSnapshots = active.map((p: any) => ({
            p,
            ...getPlayerRate(
                order.customClubRate,
                projectSnapshot?.clubRate,
                p.user?.staffRating?.rate,
                { includeCustomerServiceRate },
            ),
        }));
        const uniformRate = rateSnapshots.length > 0
            && rateSnapshots.every((item) => Math.abs(Number(item.playerRate ?? 0) - Number(rateSnapshots[0].playerRate ?? 0)) < 1e-9);

        for (const [idx, item] of rateSnapshots.entries()) {
            const p = item.p;
            let contributionBaseAmount = 0;
            let finalMoney = 0;
            let commissionRate = 0;

            if (d.status === DispatchStatus.ARCHIVED) {
                // 存单：按本轮 progressBaseWan 占订单保底比例换算
                // - 正数：按抽成率结算，并从后续可分配池扣减
                // - 负数：炸单/补单，保留原始负数，不受抽成率影响；同时回灌到后续可分配池
                const progressBaseWan = Number(p.progressBaseWan ?? 0);
                const thisMoney = orderRatio > 0 ? progressBaseWan / orderRatio : 0;

                contributionBaseAmount = thisMoney;
                if (progressBaseWan > 0) {
                    const playerRate = Number(item.playerRate ?? 0);
                    commissionRate = roundMix1(item.commissionRate ?? 0);
                    finalMoney = thisMoney * playerRate;
                } else {
                    finalMoney = thisMoney;
                    commissionRate = 0;
                }

                // 这里统一做“扣减/回灌”：
                // - 正数轮次：扣减后续可分配池
                // - 负数轮次：回灌后续可分配池
                lastPaidAmount = round2(lastPaidAmount - thisMoney);
            }

            if (d.status === DispatchStatus.COMPLETED) {
                const playerRate = Number(item.playerRate ?? 0);
                commissionRate = roundMix1(item.commissionRate ?? 0);

                if (uniformRate && completedUniformSplit) {
                    contributionBaseAmount = completedUniformSplit.base;
                    finalMoney = roundMix1(contributionBaseAmount * playerRate);
                } else {
                    const perBaseYuanList = distributeRoundedMoney(lastPaidAmount, active.length);
                    contributionBaseAmount = perBaseYuanList[idx] ?? (active.length > 0 ? lastPaidAmount / active.length : 0);
                    finalMoney = contributionBaseAmount * playerRate;
                }
            }

            const settlementType = order.settlementType ?? 'REGULAR';
            const clubEarnings = uniformRate && d.status === DispatchStatus.COMPLETED && completedUniformSplit
                ? roundMix1(contributionBaseAmount - finalMoney + (idx === 0 ? completedUniformSplit.residual : 0))
                : roundMix1(contributionBaseAmount - finalMoney);

            settlements.push({
                orderId: order.id,
                dispatchId: d.id,
                userId: p.userId,
                userName: p.user?.name,
                settlementType,
                settlementBatchId: order.settlementBatchId,
                calculatedEarnings: roundMix1(finalMoney),
                manualAdjustment: 0,
                finalEarnings: roundMix1(finalMoney),

                ownerRoleType: 'PLAYER',
                contributionBaseAmount: roundMix1(contributionBaseAmount),
                commissionRate: roundMix1(commissionRate ?? 0),
                grossPerformanceAmount: roundMix1(contributionBaseAmount),
                netIncomeAmount: roundMix1(finalMoney),
                clubEarnings,
            });
        }

        if (d.status === DispatchStatus.COMPLETED) {
            lastPaidAmount = 0;
        }
    }

    return settlements;
};
/**
 * 计算趣味玩法单应得收益：
 * - order：订单
 * - dispatches：派单记录
 * -
 */
export const computeBillingMODEPLAY = (order: any, modePlayAllocList: any) => {
    const settlements: any[] = [];
    const { status, projectSnapshot } = order;

    if (!['COMPLETED', 'COMPLETED_PENDING_CONFIRM'].includes(status)) {
        throw new BadRequestException(`订单状态异常，无法完成核算`);
    }

    const dispatches = [...(order.dispatches ?? [])].sort(
        (a, b) => (a.round ?? 0) - (b.round ?? 0),
    );

    const allocMap = new Map(
        modePlayAllocList?.map((x: any) => [Number(x.dispatchId), Number(x.income)]) ?? [],
    );

    const orderPaidAmount = getSettlementBaseAmount(order);
    const includeCustomerServiceRate = order?.dispatcher?.userType === 'CUSTOMER_SERVICE';

    for (const d of dispatches) {
        const active = sortSettlementParticipants(getSettlementParticipants(d));
        const inactive = (d.participants ?? []).filter((p: any) => p.rejectedAt);

        if (!active.length) {
            throw new BadRequestException(`派单记录有误，无法完成核算`);
        }

        // ✅ 客服收益：只在最终结单轮生成
        if (d.status === DispatchStatus.COMPLETED) {
            if (order?.dispatcher?.userType === 'CUSTOMER_SERVICE') {
                const csMoney = roundMix1(orderPaidAmount * 0.01);

                settlements.push({
                    orderId: order.id,
                    dispatchId: d.id,
                    userId: order.dispatcherId,
                    userName: order.dispatcher.name,
                    settlementType: 'CUSTOMER_SERVICE',
                    settlementBatchId: order.settlementBatchId,
                    calculatedEarnings: csMoney,
                    manualAdjustment: 0,
                    finalEarnings: csMoney,

                    ownerRoleType: 'CS',
                    contributionBaseAmount: roundMix1(orderPaidAmount),
                    commissionRate: roundMix1(0.01),
                    grossPerformanceAmount: csMoney,
                    netIncomeAmount: csMoney,
                    clubEarnings: 0,
                    csEarnings: 0,
                    inviteEarnings: 0,
                });
            }
        }

        const roundIncomeNum = Number(allocMap.get(Number(d.id)) ?? 0);
        const uniformSplit = splitEvenlyWithResidual(roundIncomeNum, active.length);
        const rateSnapshots = active.map((p: any) => ({
            p,
            ...getPlayerRate(
                order.customClubRate,
                projectSnapshot?.clubRate,
                p.user?.staffRating?.rate,
                { includeCustomerServiceRate },
            ),
        }));
        const uniformRate = rateSnapshots.length > 0
            && rateSnapshots.every((item) => Math.abs(Number(item.playerRate ?? 0) - Number(rateSnapshots[0].playerRate ?? 0)) < 1e-9);

        for (const [idx, item] of rateSnapshots.entries()) {
            const p = item.p;
            const contributionBaseAmount = uniformRate
                ? uniformSplit.base
                : (distributeRoundedMoney(roundIncomeNum, active.length)[idx] ?? 0);
            const playerRate = Number(item.playerRate ?? 0);
            const commissionRate = roundMix1(item.commissionRate ?? 0);
            const isBombLoss = roundMix1(roundIncomeNum) < 0 || roundMix1(contributionBaseAmount) < 0;
            const thisMoney = isBombLoss
                ? roundMix1(contributionBaseAmount)
                : roundMix1(contributionBaseAmount * playerRate);
            const clubEarnings = isBombLoss
                ? 0
                : (uniformRate
                    ? roundMix1(contributionBaseAmount - thisMoney + (idx === 0 ? uniformSplit.residual : 0))
                    : roundMix1(contributionBaseAmount - thisMoney));

            const settlementType = order.settlementType ?? 'REGULAR';

            settlements.push({
                orderId: order.id,
                dispatchId: d.id,
                userId: p.userId,
                userName: p.user?.name,
                settlementType,
                settlementBatchId: order.settlementBatchId,
                calculatedEarnings: thisMoney,
                manualAdjustment: 0,
                finalEarnings: thisMoney,

                ownerRoleType: 'PLAYER',
                contributionBaseAmount: roundMix1(contributionBaseAmount),
                commissionRate,
                grossPerformanceAmount: roundMix1(contributionBaseAmount),
                netIncomeAmount: roundMix1(thisMoney),
                clubEarnings,
            });
        }
    }

    return settlements;
};


/**
 * 计算抽成比例 & 打手到手比例
 * 优先级：orderClubRate > objectClubRate > userStaffRate
 * - userStaffRate：个人抽成比例 user?.staffRating?.rate
 * - orderClubRate：订单定义的抽成比例 order.customClubRate
 * - objectClubRate：项目定义的抽成比例 order.projectSnapshot.clubRate
 */
export const getPlayerRate = (
    orderClubRate: any,
    objectClubRate: any,
    userStaffRate: any,
    options?: {
        includeCustomerServiceRate?: boolean;
        extraCustomerServiceRate?: number;
    },
) => {
    let pick = orderClubRate;
    let source: 'ORDER' | 'OBJECT' | 'USER' | 'DEFAULT' = 'ORDER';
    if (pick === null || pick === undefined) {
        pick = objectClubRate;
        source = 'OBJECT';
    }
    if (pick === null || pick === undefined) {
        pick = userStaffRate;
        source = 'USER';
    }
    if (pick === null || pick === undefined) {
        pick = 0;
        source = 'DEFAULT';
    }

    const n = Number(pick);
    const baseCommissionRate = Number.isFinite(n) ? Math.max(0, Math.min(1, n > 1 ? n / 100 : n)) : 0;
    /**
     * 客服分红是独立成本，不并入打手抽成率。
     * 这里的 commissionRate 只表示打手侧抽成。
     * 客服 1% 在结算函数中单独生成 CUSTOMER_SERVICE 记录。
     */
    const commissionRate = Math.max(0, Math.min(1, baseCommissionRate));

    return {
        commissionRate,
        playerRate: 1 - commissionRate,
        source,          // ✅ 命中来源，方便存档
        raw: pick,       // ✅ 原始值（审计用，可选）
    };
};
