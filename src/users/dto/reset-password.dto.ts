import { IsString, IsOptional } from 'class-validator';

export class ResetPasswordDto {
    @IsString()
    @IsOptional()
    remark?: string;
}
