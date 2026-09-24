import { IsInt, Min } from 'class-validator';
import { CreateCouponTemplateDto } from './create-coupon-template.dto';

export class UpdateCouponTemplateDto extends CreateCouponTemplateDto {
  @IsInt()
  @Min(1)
  id: number;
}
