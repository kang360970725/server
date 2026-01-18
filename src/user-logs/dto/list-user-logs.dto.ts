import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListUserLogsDto {
    /// 我这里强制分页参数存在，并做边界控制：避免一次拉太多导致 DB 压力和前端卡顿
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page: number;

    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    pageSize: number;

    /// ✅ 操作人维度
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    userId?: number;

    /// ✅ 动作分类
    @IsOptional()
    @IsString()
    action?: string;

    /// ✅ 目标类型：ORDER / WALLET / WITHDRAWAL / SETTLEMENT ...
    @IsOptional()
    @IsString()
    targetType?: string;

    /// ✅ 目标 ID：当 targetType=ORDER 时就是订单 id（你要的“订单维度查询”）
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    targetId?: number;

    /// ✅ 关键字：我只做 action/remark 的 contains，避免对 JSON 做模糊搜索导致慢查询
    @IsOptional()
    @IsString()
    keyword?: string;

    /// ✅ 时间范围：我用字符串接收，service 内统一 new Date()，避免 DTO 解析不一致
    @IsOptional()
    @IsString()
    createdAtFrom?: string;

    @IsOptional()
    @IsString()
    createdAtTo?: string;

    /// ✅ 是否携带用户基础信息（列表展示人名/手机号/类型用）
    @IsOptional()
    @IsBoolean()
    withUser?: boolean;
}
