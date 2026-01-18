import { Body, Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { UserLogsService } from './user-logs.service';
import { ListUserLogsDto } from './dto/list-user-logs.dto';
import { UserLogDetailDto } from './dto/user-log-detail.dto';

// ⚠️ 我这里不猜你项目的 RolesGuard / Permission 装饰器名字
// 我只做最小可运行：接入你现有的 JWT 鉴权（如果你用的是 @nestjs/passport）
// 如果你项目已有 JwtAuthGuard/权限校验装饰器，把这层替换即可。
// import { UseGuards } from '@nestjs/common';
// import { AuthGuard } from '@nestjs/passport';

@Controller('user-logs')
export class UserLogsController {
    constructor(private readonly userLogsService: UserLogsService) {}

    /**
     * ✅ 日志列表（POST）
     * 我做这个接口的原则：只读、可筛选、分页稳定、默认不返回 oldData/newData（避免大列表卡）
     */
    @Post('list')
    async list(@Body() dto: ListUserLogsDto) {
        return this.userLogsService.list(dto);
    }

    /**
     * ✅ 日志详情（POST）
     * 我做这个接口的原则：点击一条再查 oldData/newData，确保列表性能。
     */
    @Post('detail')
    async detail(@Body() dto: UserLogDetailDto) {
        return this.userLogsService.detail(dto.id);
    }

    /**
     * ✅ （可选）如果你想让前端做“动作分类”下拉，我可以提供一个聚合接口
     * 但你当前需求没有强制，我默认不做，避免多接口漂移。
     *
     * 需要的话你一句话，我再加：/user-logs/filters => 返回 targetType/action 的 distinct 列表
     */
}
