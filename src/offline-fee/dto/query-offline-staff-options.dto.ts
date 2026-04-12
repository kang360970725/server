import { IsOptional, IsString } from 'class-validator';

export class QueryOfflineStaffOptionsDto {
  @IsOptional()
  @IsString()
  keyword?: string;
}

