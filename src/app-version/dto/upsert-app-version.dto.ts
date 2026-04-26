import { IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpsertAppVersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  version?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  buildId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['SMALL', 'MAJOR'])
  releaseType?: 'SMALL' | 'MAJOR';

  @IsOptional()
  @IsString()
  releasedAt?: string;

  @IsOptional()
  @IsBoolean()
  forceRefresh?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsArray()
  notes?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
