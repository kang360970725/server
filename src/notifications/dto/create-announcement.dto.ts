import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateAnnouncementDto {
  @IsString()
  @MaxLength(120)
  title: string;

  @IsString()
  content: string;

  @IsOptional()
  @IsBoolean()
  forceRead?: boolean;

  @IsOptional()
  @IsString()
  audience?: 'ADMIN' | 'APPLET' | 'ALL';

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  publishAt?: string;

  @IsOptional()
  @IsString()
  expireAt?: string;
}
