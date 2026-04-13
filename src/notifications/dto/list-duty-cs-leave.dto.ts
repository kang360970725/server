import { IsOptional, IsString } from 'class-validator';

export class ListDutyCsLeaveDto {
  @IsOptional()
  @IsString()
  keyword?: string;
}
