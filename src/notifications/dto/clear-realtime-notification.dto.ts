import { IsString } from 'class-validator';

export class ClearRealtimeNotificationDto {
  @IsString()
  id: string;
}
