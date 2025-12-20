import { IsArray, IsInt, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 结单
 * - 结单即自动结算落库
 * - 可选填写保底最终进度（如果你希望结单也可修正最终进度）
 */
export class CompleteParticipantProgressDto {
    @Type(() => Number)
    @IsInt()
    userId: number;

    @IsOptional()
    @IsNumber()
    progressBaseWan?: number;
}

export class CompleteDispatchDto {
    @IsOptional()
    @IsString()
    deductMinutesOption?: 'M10' | 'M20' | 'M30' | 'M40' | 'M50' | 'M60';

    @IsOptional()
    @IsString()
    remark?: string;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CompleteParticipantProgressDto)
    progresses?: CompleteParticipantProgressDto[];
}
