import { IsOptional } from 'class-validator';

export class MarkNotificationReadDto {
  @IsOptional()
  notificationId?: number;

  @IsOptional()
  markAll?: boolean;
}
