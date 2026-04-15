import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PenaltyRuleCategory } from '@prisma/client';

export class ListPenaltyRulesDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @IsEnum(PenaltyRuleCategory)
  category?: PenaltyRuleCategory;

  @IsOptional()
  enabled?: boolean;
}
