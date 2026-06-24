import { IsArray, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class GrantUserCouponDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  userId: number;

  @IsOptional()
  @IsArray()
  userIds?: number[];

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
