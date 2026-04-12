import { IsOptional, IsString } from 'class-validator';

export class ListAnnouncementsDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  page?: number;

  @IsOptional()
  limit?: number;
}
