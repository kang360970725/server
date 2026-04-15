import { IsInt, IsString, MaxLength, Min } from 'class-validator';

export class SubmitPenaltyAppealDto {
  @IsInt()
  @Min(1)
  ticketId: number;

  @IsString()
  @MaxLength(2000)
  content: string;
}
