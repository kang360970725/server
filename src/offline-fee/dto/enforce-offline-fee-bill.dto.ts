import { IsBoolean, IsNumber } from 'class-validator';

export class EnforceOfflineFeeBillDto {
  @IsNumber()
  billId: number;

  @IsBoolean()
  enforceFullPayment: boolean;
}
