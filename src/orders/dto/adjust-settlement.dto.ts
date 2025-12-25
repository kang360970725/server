export class AdjustSettlementDto {
    settlementId: number;
    finalEarnings: number; // 直接填目标“实际收益”
    remark?: string;
}
