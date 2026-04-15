import { IsInt, Min } from 'class-validator';

export class ConfirmPenaltyTicketDto {
  @IsInt()
  @Min(1)
  ticketId: number;
}
