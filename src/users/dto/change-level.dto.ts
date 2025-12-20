import { IsInt, IsString, IsOptional } from 'class-validator';

export class ChangeLevelDto {
    @IsInt()
    rating: number;  // 改为评级ID

    @IsString()
    @IsOptional()
    remark?: string;
}
