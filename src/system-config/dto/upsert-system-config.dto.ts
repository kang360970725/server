import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

enum ConfigValueTypeDto {
  NUMBER = 'NUMBER',
  STRING = 'STRING',
  BOOLEAN = 'BOOLEAN',
  JSON = 'JSON',
}

export class UpsertSystemConfigDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  key: string;

  @IsString()
  value: string;

  @IsEnum(ConfigValueTypeDto)
  @IsOptional()
  valueType?: ConfigValueTypeDto;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  remark?: string;

  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}
