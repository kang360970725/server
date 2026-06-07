import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { FinanceService } from './finance.service';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { FinanceDashboardSummaryDto } from './dto/finance-dashboard-summary.dto';
import { FinanceDashboardTrendDto } from './dto/finance-dashboard-trend.dto';
import { FinanceDashboardCostStructureDto } from './dto/finance-dashboard-cost-structure.dto';
import { FinanceRecordListDto } from './dto/finance-record-list.dto';

@Controller('finance')
@UseGuards(PermissionsGuard)
export class FinanceController {
    constructor(private readonly financeService: FinanceService) {}

    @Post('dashboard/summary')
    @Permissions('finance:dashboard:view')
    async dashboardSummary(@Body() body: FinanceDashboardSummaryDto) {
        return this.financeService.dashboardSummary(body);
    }

    @Post('dashboard/trend')
    @Permissions('finance:dashboard:view')
    async dashboardTrend(@Body() body: FinanceDashboardTrendDto) {
        return this.financeService.dashboardTrend(body);
    }

    @Post('dashboard/cost-structure')
    @Permissions('finance:dashboard:view')
    async dashboardCostStructure(@Body() body: FinanceDashboardCostStructureDto) {
        return this.financeService.dashboardCostStructure(body);
    }

    @Post('dashboard/daily-overview')
    @Permissions('orders:detail:page', 'finance:dashboard:view')
    async dashboardDailyOverview(@Body() body: { startDate?: string; endDate?: string }) {
        return this.financeService.dashboardDailyOverview(body);
    }

    @Post('dashboard/reconciliation')
    @Permissions('orders:detail:page', 'finance:dashboard:view')
    async dashboardReconciliation(@Body() body: { startDate?: string; endDate?: string }) {
        return this.financeService.dashboardReconciliation(body);
    }

    @Post('dashboard/shift-overview')
    @Permissions('orders:detail:page', 'finance:dashboard:view')
    async dashboardShiftOverview(
        @Body() body: { date: string; dispatcherId?: number; currentOrderId?: number },
    ) {
        return this.financeService.dashboardShiftOverview(body);
    }

    @Post('records/list')
    @Permissions('finance:records:list')
    async recordsList(@Body() body: FinanceRecordListDto) {
        return this.financeService.recordsList(body);
    }
}
