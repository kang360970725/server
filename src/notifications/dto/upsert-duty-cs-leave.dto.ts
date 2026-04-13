import { IsBoolean, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpsertDutyCsLeaveDto {
  @IsOptional()
  @IsNumber()
  id?: number;

  @IsNumber()
  userId: number;

  @IsNumber()
  substituteUserId: number;

  @IsString()
  startAt: string;

  @IsString()
  endAt: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
