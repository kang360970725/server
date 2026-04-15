import { IsInt, IsOptional, Min } from 'class-validator';

export class ListPenaltyRankingDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  top?: number;
}
