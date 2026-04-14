import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class GrantUserCouponDto {
  @IsInt()
  @Min(1)
  userId: number;

  @IsInt()
  @Min(1)
  templateId: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  count?: number;

  @IsOptional()
  @IsString()
  expiresAt?: string;
}
