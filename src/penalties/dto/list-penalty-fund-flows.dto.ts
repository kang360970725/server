import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { PenaltyFundBizType, PenaltyFundDirection } from '@prisma/client';

export class ListPenaltyFundFlowsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsEnum(PenaltyFundDirection)
  direction?: PenaltyFundDirection;

  @IsOptional()
  @IsEnum(PenaltyFundBizType)
  bizType?: PenaltyFundBizType;
}
