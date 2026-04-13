import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpsertDutyCsScheduleDto {
  @IsOptional()
  @IsNumber()
  id?: number;

  @IsNumber()
  userId: number;

  @IsOptional()
  @IsNumber()
  weekday?: number;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  weekdays?: number[];

  @IsString()
  startTime: string;

  @IsString()
  endTime: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}
