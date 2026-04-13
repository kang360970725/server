import { IsNumber } from 'class-validator';

export class DeleteDutyCsLeaveDto {
  @IsNumber()
  id: number;
}
