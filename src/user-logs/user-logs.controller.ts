import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { UserLogsService } from './user-logs.service';
import { ListUserLogsDto } from './dto/list-user-logs.dto';
import { UserLogDetailDto } from './dto/user-log-detail.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';

const USER_LOGS_PAGE = 'system:user-logs:page';
const LEGACY_SYSTEM_ADMIN_PAGE = 'system:role:page';

@Controller('user-logs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class UserLogsController {
    constructor(private readonly userLogsService: UserLogsService) {}

    /**
     * ✅ 日志列表（POST）
     * 我做这个接口的原则：只读、可筛选、分页稳定、默认不返回 oldData/newData（避免大列表卡）
     */
    @Post('list')
    @Permissions(USER_LOGS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
    async list(@Body() dto: ListUserLogsDto) {
        return this.userLogsService.list(dto);
    }

    /**
     * ✅ 日志详情（POST）
     * 我做这个接口的原则：点击一条再查 oldData/newData，确保列表性能。
     */
    @Post('detail')
    @Permissions(USER_LOGS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
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
