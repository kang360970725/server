import { IsArray, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreatePenaltyTicketDto {
  @IsInt()
  @Min(1)
  userId: number;

  // 允许多选处罚条例
  @IsArray()
  ruleIds: number[];

  // 允许运营按实际情况覆盖累计金额
  @IsOptional()
  @IsNumber()
  @Min(0)
  finalAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
