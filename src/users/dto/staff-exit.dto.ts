import { IsBoolean, IsEnum, IsOptional } from 'class-validator';

export enum StaffExitMode {
  RELEASE_TO_AVAILABLE = 'RELEASE_TO_AVAILABLE',
  CLEAR_ALL = 'CLEAR_ALL',
}

export class StaffExitDto {
  @IsEnum(StaffExitMode)
  mode: StaffExitMode;

  @IsOptional()
  @IsBoolean()
  addToBlacklist?: boolean;
}
