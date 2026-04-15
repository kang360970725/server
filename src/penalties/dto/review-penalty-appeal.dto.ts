import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class ReviewPenaltyAppealDto {
  @IsInt()
  @Min(1)
  ticketId: number;

  @IsBoolean()
  approved: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reviewRemark?: string;
}
