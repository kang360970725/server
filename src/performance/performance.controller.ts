import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { PerformanceService } from './performance.service';
import { PerformanceDashboardOverviewDto } from './dto/performance-dashboard-overview.dto';
import { PerformanceDashboardListDto } from './dto/performance-dashboard-list.dto';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';

@Controller('performance')
@UseGuards(PermissionsGuard)
export class PerformanceController {
    constructor(private readonly performanceService: PerformanceService) {}

    /**
     * 总看板概览
     */
    @Post('dashboard/overview')
    @Permissions('performance:dashboard:view')
    async dashboardOverview(@Body() body: PerformanceDashboardOverviewDto) {
        return this.performanceService.dashboardOverview(body);
    }

    /**
     * 总看板列表
     */
    @Post('dashboard/list')
    @Permissions('performance:dashboard:view')
    async dashboardList(@Body() body: PerformanceDashboardListDto) {
        return this.performanceService.dashboardList(body);
    }
}