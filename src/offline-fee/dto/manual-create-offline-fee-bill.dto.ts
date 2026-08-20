import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class ManualCreateOfflineFeeBillDto {
  @IsNumber()
  userId: number;

  @IsString()
  month: string;

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
