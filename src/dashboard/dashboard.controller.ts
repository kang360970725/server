import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DashboardService } from './dashboard.service';
import { QueryRevenueOverviewDto } from './dto/query-revenue-overview.dto';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
    constructor(private readonly dashboardService: DashboardService) {}

    /**
     * 全平台营业额看板（实时聚合）
     * GET /dashboard/revenue/overview?startAt=&endAt=
     */
    @Get('revenue/overview')
    async revenueOverview(@Query() query: QueryRevenueOverviewDto) {
        return this.dashboardService.getRevenueOverview(query);
    }
}
