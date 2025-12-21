import { IsEnum } from 'class-validator';
import { PlayerWorkStatus } from '@prisma/client';

export class UpdateWorkStatusDto {
    @IsEnum(PlayerWorkStatus)
    workStatus: PlayerWorkStatus;
}
