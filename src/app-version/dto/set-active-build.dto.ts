import { IsString, MaxLength } from 'class-validator';

export class SetActiveBuildDto {
  @IsString()
  @MaxLength(128)
  buildId!: string;
}

