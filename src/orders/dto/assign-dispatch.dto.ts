import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 派单 / 更新参与者
 * - v0.1：应用层限制最多 2 人（你说不必 DB 强约束）
 * - 仅当前 dispatch.status=WAIT_ASSIGN 才允许变更参与者
 */
export class AssignDispatchDto {
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(2)
    @Type(() => Number)
    @IsInt({ each: true })
    playerIds: number[];

    @IsOptional()
    @IsString()
    remark?: string;
}
