import { IsNumber } from 'class-validator';

export class ReadAnnouncementDto {
  @IsNumber()
  announcementId: number;
}
