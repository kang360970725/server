import { IsNumber, IsOptional, IsString } from 'class-validator';

export class PayOfflineFeeBillDto {
  @IsNumber()
  billId: number;

  @IsNumber()
  amount: number;

  @IsOptional()
  @IsString()
  remark?: string;
}
