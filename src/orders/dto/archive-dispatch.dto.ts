import { IsArray, IsInt, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 存单
 * - 小时单：可选 deductMinutes（10/20/.../60）
 * - 保底单：每个陪玩提交 progressBaseWan（允许负数：炸单）
 */
export class ArchiveParticipantProgressDto {
    @Type(() => Number)
    @IsInt()
    userId: number;

    @IsOptional()
    @IsNumber()
    progressBaseWan?: number; // 保底进度（万），允许负数（炸单）
}

export class ArchiveDispatchDto {
    @IsOptional()
    @IsString()
    deductMinutesOption?: 'M10' | 'M20' | 'M30' | 'M40' | 'M50' | 'M60';

    @IsOptional()
    @IsString()
    remark?: string;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ArchiveParticipantProgressDto)
    progresses?: ArchiveParticipantProgressDto[];
}
