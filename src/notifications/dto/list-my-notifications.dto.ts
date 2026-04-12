import { IsOptional, IsString } from 'class-validator';

export class ListMyNotificationsDto {
  @IsOptional()
  page?: number;

  @IsOptional()
  limit?: number;

  @IsOptional()
  @IsString()
  type?: string;
}
