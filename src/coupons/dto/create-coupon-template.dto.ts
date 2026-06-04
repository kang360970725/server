import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { CouponScope, CouponTemplateStatus, CouponTemplateType } from '@prisma/client';

export class CreateCouponTemplateDto {
  @IsString()
  @MaxLength(120)
  name: string;

  @IsEnum(CouponTemplateType)
  type: CouponTemplateType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountValue?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  thresholdAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxDiscountAmount?: number;

  @IsOptional()
  @IsEnum(CouponScope)
  applicableScope?: CouponScope;

  @IsOptional()
  @IsArray()
  applicableProjectIds?: Array<number | string>;

  @IsOptional()
  @IsEnum(CouponTemplateStatus)
  status?: CouponTemplateStatus;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  totalLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  perUserLimit?: number;
}
