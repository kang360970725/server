import { IsOptional, IsString } from 'class-validator';

/**
 * 陪玩接单
 * - 默认使用 req.user.userId 作为接单人
 */
export class AcceptDispatchDto {
    @IsOptional()
    @IsString()
    remark?: string;
}
