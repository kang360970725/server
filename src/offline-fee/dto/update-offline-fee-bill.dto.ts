import { IsNumber, Min } from 'class-validator';

export class UpdateOfflineFeeBillDto {
  @IsNumber()
  billId: number;

  // 仅允许调整业绩基数，其他金额字段由系统自动重算，避免数据口径不一致
  @IsNumber()
  @Min(0)
  performanceBaseAmount: number;
}

