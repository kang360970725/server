import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { PenaltyAppealStatus, PenaltyTicketStatus } from '@prisma/client';

export class ListPenaltyTicketsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  userId?: number;

  @IsOptional()
  @IsEnum(PenaltyTicketStatus)
  status?: PenaltyTicketStatus;

  @IsOptional()
  @IsEnum(PenaltyAppealStatus)
  appealStatus?: PenaltyAppealStatus;

  @IsOptional()
  @IsString()
  keyword?: string;
}
