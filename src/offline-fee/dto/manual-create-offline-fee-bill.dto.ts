import { IsNumber, IsString, Min } from 'class-validator';

export class ManualCreateOfflineFeeBillDto {
  @IsNumber()
  userId: number;

  @IsString()
  month: string;

  @IsNumber()
  @Min(0)
  performanceBaseAmount: number;
}

