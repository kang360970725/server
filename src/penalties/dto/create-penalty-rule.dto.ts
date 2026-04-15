import { IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PenaltyRuleCategory } from '@prisma/client';

export class CreatePenaltyRuleDto {
  @IsString()
  @MaxLength(32)
  code: string;

  @IsString()
  @MaxLength(120)
  name: string;

  @IsEnum(PenaltyRuleCategory)
  category: PenaltyRuleCategory;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @IsOptional()
  enabled?: boolean;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;
}
