import { IsNumber } from 'class-validator';

export class DeleteDutyCsScheduleDto {
  @IsNumber()
  id: number;
}
