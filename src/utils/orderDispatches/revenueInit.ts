import {round2, roundMix1, toNum} from "../money/format";
import {DispatchStatus} from "@prisma/client";
import {BadRequestException} from "@nestjs/common";

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
    const {
        paidAmount,
        receivableAmount,
        orderQuantity,
        projectSnapshot,
    } = order;

    const dispatches = [...(order.dispatches ?? [])].sort(
        (a, b) => (a.round ?? 0) - (b.round ?? 0),
    );

    let lastPaidAmount = order.isGifted ? receivableAmount : paidAmount;
    const orderPaidAmount = order.isGifted ? receivableAmount : paidAmount;

    const orderMeanPrice = roundMix1(lastPaidAmount / orderQuantity);
    if (orderMeanPrice !== order.projectSnapshot?.price) {
        // todo: 存在手动折扣时，这里后续可扩展校验/记录
    }

    const unitPrice =
        orderMeanPrice > order.projectSnapshot?.price
            ? order.projectSnapshot?.price
            : orderMeanPrice;

    for (const d of dispatches) {
        const active = (d.participants ?? []).filter((p: any) => p.acceptedAt && !p.rejectedAt);
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
            lastPaidAmount = 0;

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

        const perBaseYuanList = distributeRoundedMoney(thisMoney, active.length);

        for (const [idx, p] of active.entries()) {
            const { playerRate, commissionRate } = getPlayerRate(
                order.customClubRate,
                projectSnapshot?.clubRate,
                p.user?.staffRating?.rate,
            );

            const perBaseYuan = perBaseYuanList[idx] ?? 0;
            const expectedCalculated = roundMix1(perBaseYuan * playerRate);
            const settlementType = order.settlementType ?? 'REGULAR';

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
                commissionRate: roundMix1(commissionRate ?? 0),
                grossPerformanceAmount: roundMix1(perBaseYuan),
                netIncomeAmount: roundMix1(expectedCalculated),
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
    const {
        status,
        paidAmount,
        receivableAmount,
        baseAmountWan,
        projectSnapshot,
    } = order;

    if (!['COMPLETED', 'COMPLETED_PENDING_CONFIRM'].includes(status)) {
        throw new BadRequestException(`订单状态异常，无法完成核算`);
    }

    const dispatches = [...(order.dispatches ?? [])].sort(
        (a, b) => (a.round ?? 0) - (b.round ?? 0),
    );

    let lastPaidAmount = Number(order.isGifted ? receivableAmount : paidAmount) || 0;
    const orderPaidAmount = order.isGifted ? receivableAmount : paidAmount;

    const orderRatio = lastPaidAmount > 0 ? Number(baseAmountWan) / lastPaidAmount : 0;

    for (const d of dispatches) {
        const active = (d.participants ?? []).filter((p: any) => p.acceptedAt && !p.rejectedAt);
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

        for (const p of active) {
            let contributionBaseAmount = 0;
            let finalMoney = 0;
            let commissionRate = 0;

            if (d.status === DispatchStatus.ARCHIVED) {
                // 存单：按本轮 progressBaseWan 占订单保底比例换算
                const progressBaseWan = Number(p.progressBaseWan ?? 0);
                const thisMoney = orderRatio > 0 ? progressBaseWan / orderRatio : 0;
                lastPaidAmount = round2(lastPaidAmount - thisMoney);

                if (progressBaseWan > 0) {
                    const rateRes = getPlayerRate(
                        order.customClubRate,
                        projectSnapshot?.clubRate,
                        p.user?.staffRating?.rate,
                    );
                    const playerRate = Number(rateRes.playerRate ?? 0);
                    commissionRate = roundMix1(rateRes.commissionRate ?? 0);

                    contributionBaseAmount = thisMoney;
                    finalMoney = thisMoney * playerRate;
                } else {
                    // ✅ 炸单/负收益，直接保留原值（通常为负）
                    contributionBaseAmount = thisMoney;
                    finalMoney = thisMoney;
                    commissionRate = 0;
                }
            }

            if (d.status === DispatchStatus.COMPLETED) {
                const rateRes = getPlayerRate(
                    order.customClubRate,
                    projectSnapshot?.clubRate,
                    p.user?.staffRating?.rate,
                );
                const playerRate = Number(rateRes.playerRate ?? 0);
                commissionRate = roundMix1(rateRes.commissionRate ?? 0);

                contributionBaseAmount = active.length > 0 ? lastPaidAmount / active.length : 0;
                finalMoney = contributionBaseAmount * playerRate;
                lastPaidAmount = 0;
            }

            const settlementType = order.settlementType ?? 'REGULAR';

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
            });
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
    const {
        status,
        projectSnapshot,
        paidAmount,
        receivableAmount,
    } = order;

    if (!['COMPLETED', 'COMPLETED_PENDING_CONFIRM'].includes(status)) {
        throw new BadRequestException(`订单状态异常，无法完成核算`);
    }

    const dispatches = [...(order.dispatches ?? [])].sort(
        (a, b) => (a.round ?? 0) - (b.round ?? 0),
    );

    const allocMap = new Map(
        modePlayAllocList?.map((x: any) => [Number(x.dispatchId), Number(x.income)]) ?? [],
    );

    const orderPaidAmount = order.isGifted ? receivableAmount : paidAmount;

    for (const d of dispatches) {
        const active = (d.participants ?? []).filter((p: any) => p.acceptedAt && !p.rejectedAt);
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
        const baseShareList = distributeRoundedMoney(roundIncomeNum, active.length);

        for (const [idx, p] of active.entries()) {
            const contributionBaseAmount = baseShareList[idx] ?? 0;

            const { playerRate, commissionRate } = getPlayerRate(
                order.customClubRate,
                projectSnapshot?.clubRate,
                p.user?.staffRating?.rate,
            );

            const thisMoney = roundMix1(
                contributionBaseAmount * Number(playerRate ?? 0),
            );

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
                commissionRate: roundMix1(commissionRate ?? 0),
                grossPerformanceAmount: roundMix1(contributionBaseAmount),
                netIncomeAmount: roundMix1(thisMoney),
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
export const getPlayerRate = (orderClubRate: any, objectClubRate: any, userStaffRate: any) => {
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
    const commissionRate = Number.isFinite(n) ? Math.max(0, Math.min(1, n > 1 ? n / 100 : n)) : 0;

    return {
        commissionRate,
        playerRate: 1 - commissionRate,
        source,          // ✅ 命中来源，方便存档
        raw: pick,       // ✅ 原始值（审计用，可选）
    };
};
