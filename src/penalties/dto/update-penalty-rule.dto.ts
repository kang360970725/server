import { IsEnum, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PenaltyRuleCategory } from '@prisma/client';

export class UpdatePenaltyRuleDto {
  @IsInt()
  @Min(1)
  id: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEnum(PenaltyRuleCategory)
  category?: PenaltyRuleCategory;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

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
