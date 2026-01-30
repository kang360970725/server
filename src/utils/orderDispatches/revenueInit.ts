import {roundMix1, toNum} from "../money/format";
import {DispatchStatus} from "@prisma/client";
import {BadRequestException} from "@nestjs/common";
const gameObjectTypes:any = ['EXPERIENCE','LUCKY_BAG','BLIND_BOX']
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
    const settlements: any = [];
    const {
        paidAmount, // 实付金额
        receivableAmount, // 应付金额
        orderQuantity, //下单时长
        projectSnapshot, //订单快照(获取小时单单价、自定义的抽成比例)
        csRate, //客服收益比例（默认 1%，体验单可设为 0）
    } = order

    //status: ARCHIVED 存单  COMPLETED 结单
    const dispatches = [...(order.dispatches ?? [])].sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
    let lastPaidAmount = order.isGifted ? receivableAmount : paidAmount; //如果是赠送单或者其他平台单，实付金额为0，则需要取应付金额。
    let orderPaidAmount = order.isGifted ? receivableAmount : paidAmount; //如果是赠送单或者其他平台单，实付金额为0，则需要取应付金额。

    const orderMeanPrice = roundMix1(lastPaidAmount / orderQuantity) //计算小时单价
    if(orderMeanPrice !== order.projectSnapshot?.price){
        //todo 如果计算值与默认值不匹配，则说明存在手动折扣。需核对订单总小时

    }
    const unitPrice = orderMeanPrice > order.projectSnapshot?.price ? order.projectSnapshot?.price : orderMeanPrice
    for (const d of dispatches) {
        // -acceptedAt 接单时间(接单后才存在)
        // -rejectedAt 拒单时间(拒单后才存在)
        const active = (d.participants ?? []).filter((p: any) => p.acceptedAt);
        //todo 拒单- 拒单惩罚从这里开始
        const inactive = (d.participants ?? []).filter((p: any) => p.rejectedAt);
        if (!active.length) {
            throw new BadRequestException(`派单记录有误，无法完成核算`);
        }

        const endAt = d.status === DispatchStatus.COMPLETED ? d.completedAt : d.archivedAt;

        // 优先使用历史已落库 billableHours；否则按规则从 acceptedAt/archivedAt/completedAt 兜底计算
        // 参与者 acceptedAt 可能不一致：这里取“最早接单时间”作为整轮开始（更符合“轮次统一计费”）
        const acceptedAtMin = active
            .map((p: any) => p.acceptedAt)
            .filter(Boolean)
            .sort((a: any, b: any) => +new Date(a) - +new Date(b))[0] as Date | undefined;

        const roundHours = Number.isFinite(toNum(d.billableHours))
            ? roundMix1(toNum(d.billableHours))
            : calcBillableHours(acceptedAtMin ?? null, endAt ?? null, d.deductMinutesValue ?? 0);


        // 本轮应分配金额（单价*时长。存单轮次按 roundHours 分摊；结单轮次吃剩余）
        let thisMoney: number = 0;
        if (d.status === DispatchStatus.ARCHIVED) {
            thisMoney = roundMix1(roundHours * unitPrice)
            thisMoney = thisMoney <= lastPaidAmount ? thisMoney : lastPaidAmount
            lastPaidAmount -= thisMoney
        }
        if(d.status === DispatchStatus.COMPLETED){
            thisMoney = roundMix1(lastPaidAmount * 1)
            lastPaidAmount = 0
            if(order?.dispatcher.userType === 'CUSTOMER_SERVICE' && !gameObjectTypes.includes(projectSnapshot?.type)){
                settlements.push({
                    orderId: order.id,
                    dispatchId: d.id,
                    userId: order.dispatcherId,
                    userName: order.dispatcher.name,
                    settlementType: 'CUSTOMER_SERVICE',
                    settlementBatchId: order.settlementBatchId, // ✅建议从外部传进来或挂到 order 上
                    calculatedEarnings: roundMix1(orderPaidAmount * 0.01),      // Decimal(10,1) 允许 number（Prisma 会转），不稳就转 string
                    manualAdjustment: 0,
                    finalEarnings: roundMix1(orderPaidAmount * 0.01),
                    // 可选：你现在还没算俱乐部/客服/邀请的拆分，就先不写或写 0
                    // clubEarnings: null,
                    // csEarnings: null,
                    // inviteEarnings: null,
                })
            }
        }

        const perBaseYuan = roundMix1(thisMoney / active.length);

        for (const p of active) {
            const {playerRate, commissionRate} = getPlayerRate(order.customClubRate, projectSnapshot?.clubRate, p.user?.staffRating?.rate);
            const expectedCalculated = roundMix1(perBaseYuan * playerRate);

            const settlementType = order.settlementType ?? 'REGULAR'; // 或者你传参进来
            settlements.push({
                orderId: order.id,
                dispatchId: d.id,
                userId: p.userId,
                settlementType,
                settlementBatchId: order.settlementBatchId, // ✅建议从外部传进来或挂到 order 上
                calculatedEarnings: expectedCalculated,      // Decimal(10,1) 允许 number（Prisma 会转），不稳就转 string
                manualAdjustment: 0,
                finalEarnings: expectedCalculated,
                // 可选：你现在还没算俱乐部/客服/邀请的拆分，就先不写或写 0
                // clubEarnings: null,
                // csEarnings: null,
                // inviteEarnings: null,
            });
        }
    }
    return settlements
};

/**
 * 计算保底单应得收益：
 * - order：订单
 * - dispatches：派单记录
 * -
 */
export const computeBillingGuaranteed = (order: any) => {
    const settlements: any = [];
    const {
        status,
        paidAmount, // 实付金额
        receivableAmount, // 应付金额
        baseAmountWan, //订单保底
        projectSnapshot, //订单快照(获取小时单单价、自定义的抽成比例)
        csRate, //客服收益比例（默认 1%，体验单可设为 0）
    } = order
    //只有已结单待确认或已结单，才允许重算。
    if(!['COMPLETED','COMPLETED_PENDING_CONFIRM'].includes(status)) throw new BadRequestException(`订单状态异常，无法完成核算`);
    //status: ARCHIVED 存单  COMPLETED 结单
    const dispatches = [...(order.dispatches ?? [])].sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
    let lastPaidAmount = order.isGifted ? receivableAmount : paidAmount; //如果是赠送单或者其他平台单，实付金额为0，则需要取应付金额。
    let orderPaidAmount = order.isGifted ? receivableAmount : paidAmount; //如果是赠送单或者其他平台单，实付金额为0，则需要取应付金额。

    //获取订单比例
    const orderRatio = roundMix1(baseAmountWan / lastPaidAmount)
    for (const d of dispatches) {
        // -acceptedAt 接单时间(接单后才存在)
        // -rejectedAt 拒单时间(拒单后才存在)
        const active = (d.participants ?? []).filter((p: any) => p.acceptedAt);
        //todo 拒单- 拒单惩罚从这里开始
        const inactive = (d.participants ?? []).filter((p: any) => p.rejectedAt);
        if (!active.length) {
            throw new BadRequestException(`派单记录有误，无法完成核算`);
        }
        for (const p of active) {
            let thisMoney: number = 0.00;
            if(d.status === DispatchStatus.ARCHIVED){
                //存单，挨个计算本次收益
                // 本轮应分配金额（总贡献/比例。存单轮次按总保底分摊；结单轮次吃剩余）
                thisMoney = roundMix1(p.progressBaseWan / orderRatio)
                lastPaidAmount -= thisMoney
                if(p.progressBaseWan > 0){ //正常存单，没炸单
                    const {playerRate, commissionRate} = getPlayerRate(order.customClubRate, projectSnapshot?.clubRate, p.user?.staffRating?.rate);
                    thisMoney = roundMix1(thisMoney * playerRate);
                }
            }
            //结单，获取剩余收益
            if (d.status === DispatchStatus.COMPLETED) {
                const {playerRate, commissionRate} = getPlayerRate(order.customClubRate, projectSnapshot?.clubRate, p.user?.staffRating?.rate);
                thisMoney = roundMix1((lastPaidAmount / active.length) * playerRate);
                // 已存在结单，计算客服收益
                if(order?.dispatcher.userType === 'CUSTOMER_SERVICE' && !gameObjectTypes.includes(projectSnapshot?.type)){
                    settlements.push({
                        orderId: order.id,
                        dispatchId: d.id,
                        userId: order.dispatcherId,
                        userName: order.dispatcher.name,
                        settlementType: 'CUSTOMER_SERVICE',
                        settlementBatchId: order.settlementBatchId, // ✅建议从外部传进来或挂到 order 上
                        calculatedEarnings: roundMix1(orderPaidAmount * 0.01),      // Decimal(10,1) 允许 number（Prisma 会转），不稳就转 string
                        manualAdjustment: 0,
                        finalEarnings: roundMix1(orderPaidAmount * 0.01),
                        // 可选：你现在还没算俱乐部/客服/邀请的拆分，就先不写或写 0
                        // clubEarnings: null,
                        // csEarnings: null,
                        // inviteEarnings: null,
                    })
                }
            }
            const settlementType = order.settlementType ?? 'REGULAR'; // 或者你传参进来
            settlements.push({
                orderId: order.id,
                dispatchId: d.id,
                userId: p.userId,
                userName: p.user.name,
                settlementType,
                settlementBatchId: order.settlementBatchId, // ✅建议从外部传进来或挂到 order 上
                calculatedEarnings: thisMoney,      // Decimal(10,1) 允许 number（Prisma 会转），不稳就转 string
                manualAdjustment: 0,
                finalEarnings: thisMoney,
                // 可选：你现在还没算俱乐部/客服/邀请的拆分，就先不写或写 0
                // clubEarnings: null,
                // csEarnings: null,
                // inviteEarnings: null,
            });
        }
    }
    return settlements
};
/**
 * 计算趣味玩法单应得收益：
 * - order：订单
 * - dispatches：派单记录
 * -
 */
export const computeBillingMODEPLAY = (order: any, modePlayAllocList: any) => {
    const settlements: any = [];
    const {
        status,
        projectSnapshot, //订单快照(获取小时单单价、自定义的抽成比例)
        paidAmount, // 实付金额
        receivableAmount, // 应付金额
        csRate, //客服收益比例（默认 1%，体验单可设为 0）
    } = order
    //只有已结单待确认或已结单，才允许重算。
    if(!['COMPLETED','COMPLETED_PENDING_CONFIRM'].includes(status)) throw new BadRequestException(`订单状态异常，无法完成核算`);
    //status: ARCHIVED 存单  COMPLETED 结单
    const dispatches = [...(order.dispatches ?? [])].sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
    const allocMap = new Map(modePlayAllocList?.map(x => [Number(x.dispatchId), Number(x.income)]) ?? []);
    let orderPaidAmount = order.isGifted ? receivableAmount : paidAmount; //如果是赠送单或者其他平台单，实付金额为0，则需要取应付金额。
    for (const d of dispatches) {
        // -acceptedAt 接单时间(接单后才存在)
        // -rejectedAt 拒单时间(拒单后才存在)
        const active = (d.participants ?? []).filter((p: any) => p.acceptedAt);
        //todo 拒单- 拒单惩罚从这里开始
        const inactive = (d.participants ?? []).filter((p: any) => p.rejectedAt);
        if (!active.length) {
            throw new BadRequestException(`派单记录有误，无法完成核算`);
        }
        for (const p of active) {
            //根据传递进来的每轮收益挨个计算下面参与者的本次收益
            //根据当前轮参与人数均分
            const {playerRate, commissionRate} = getPlayerRate(order.customClubRate, projectSnapshot?.clubRate, p.user?.staffRating?.rate);

            const roundIncomeNum = Number(allocMap.get(Number(d.id)) ?? 0);
            const activeCount = Number(active.length);
            const playerRateNum = Number(playerRate ?? 0);

            const thisMoney = roundMix1(
                (roundIncomeNum / activeCount) * playerRateNum,
            );
            //结单，获取剩余收益
            if (d.status === DispatchStatus.COMPLETED) {
                // 已存在结单，需计算客服收益
                if(order?.dispatcher.userType === 'CUSTOMER_SERVICE' && !gameObjectTypes.includes(projectSnapshot?.type)){
                    settlements.push({
                        orderId: order.id,
                        dispatchId: d.id,
                        userId: order.dispatcherId,
                        userName: order.dispatcher.name,
                        settlementType: 'CUSTOMER_SERVICE',
                        settlementBatchId: order.settlementBatchId, // ✅建议从外部传进来或挂到 order 上
                        calculatedEarnings: roundMix1(orderPaidAmount * 0.01),      // Decimal(10,1) 允许 number（Prisma 会转），不稳就转 string
                        manualAdjustment: 0,
                        finalEarnings: roundMix1(orderPaidAmount * 0.01),
                        // 可选：你现在还没算俱乐部/客服/邀请的拆分，就先不写或写 0
                        // clubEarnings: null,
                        // csEarnings: null,
                        // inviteEarnings: null,
                    })
                }
            }
            const settlementType = order.settlementType ?? 'REGULAR'; // 或者你传参进来
            settlements.push({
                orderId: order.id,
                dispatchId: d.id,
                userId: p.userId,
                userName: p.user.name,
                settlementType,
                settlementBatchId: order.settlementBatchId, // ✅建议从外部传进来或挂到 order 上
                calculatedEarnings: thisMoney,      // Decimal(10,1) 允许 number（Prisma 会转），不稳就转 string
                manualAdjustment: 0,
                finalEarnings: thisMoney,
                // 可选：你现在还没算俱乐部/客服/邀请的拆分，就先不写或写 0
                // clubEarnings: null,
                // csEarnings: null,
                // inviteEarnings: null,
            });
        }
    }
    return settlements
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

