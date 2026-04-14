import { IsEnum, IsInt, Min } from 'class-validator';
import { CouponTemplateStatus } from '@prisma/client';

export class UpdateCouponTemplateStatusDto {
  @IsInt()
  @Min(1)
  id: number;

  @IsEnum(CouponTemplateStatus)
  status: CouponTemplateStatus;
}
