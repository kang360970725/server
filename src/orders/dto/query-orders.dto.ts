import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';
import { Transform, Type } from 'class-transformer';

/**
 * 列表筛选 DTO
 * 要求支持：
 * 单号/项目/状态/陪玩/派单人/客户游戏ID
 */
export class QueryOrdersDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    page?: number = 1;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    limit?: number = 10;

    @IsOptional()
    @IsString()
    serial?: string; // autoSerial 模糊

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    projectId?: number;

    @IsOptional()
    @IsString()
    status?: string; // OrderStatus（字符串）

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    playerId?: number; // 陪玩 userId

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    dispatcherId?: number;

    @IsOptional()
    @IsString()
    customerGameId?: string;

    @IsOptional()
    @Transform(({ value }) => {
        if (value === undefined || value === null || value === '') return undefined;
        if (value === true || value === 'true' || value === 1 || value === '1') return true;
        if (value === false || value === 'false' || value === 0 || value === '0') return false;
        return Boolean(value);
    })
    @IsBoolean()
    isPaid?: boolean;
}
