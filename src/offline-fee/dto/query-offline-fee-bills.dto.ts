import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class QueryOfflineFeeBillsDto {
  @IsOptional()
  @IsString()
  billMonth?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  userId?: number;

  @IsOptional()
  page?: number;

  @IsOptional()
  limit?: number;

  @IsOptional()
  @IsBoolean()
  onlyOutstanding?: boolean;
}
