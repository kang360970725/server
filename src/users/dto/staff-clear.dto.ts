import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class StaffClearDto {
  @IsOptional()
  @IsBoolean()
  addToBlacklist?: boolean;

  @IsString()
  @MaxLength(255)
  remark: string;
}
