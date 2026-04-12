import { IsOptional, IsString } from 'class-validator';

export class ListDutyCsScheduleDto {
  @IsOptional()
  @IsString()
  keyword?: string;
}
