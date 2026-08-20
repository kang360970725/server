import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateOfflineFeeBillDto {
  @IsNumber()
  billId: number;

  // 兼容旧字段；新线下费用账单按 amount 直接作为扣费金额。
  @IsOptional()
  @IsNumber()
  @Min(0)
  performanceBaseAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsString()
  dueAt?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}
