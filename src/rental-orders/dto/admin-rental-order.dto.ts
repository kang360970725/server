// 管理端输入与领域数据分离；金额、日期、布尔值均由领域规则做运行时校验。
export class CreateAdminRentalOrderDto {
  staffUserId: number;
  prepaidAmount: number;
  depositAmount?: number;
  accountSourceNo: string;
  forcedSettlementDate: string;
}
export class SettleAdminRentalOrderDto {
  version: number;
  noRefundDifference: boolean;
  refundDifferenceAmount?: number;
  refundDifferenceRemark?: string;
  lossAmount?: number;
  lossDetail?: string;
  hasAbnormalCompensation: boolean;
  abnormalCompensationAmount?: number;
  abnormalCompensationRemark?: string;
  ownerSettlementAmount: number;
}
