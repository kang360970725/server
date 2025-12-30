import { Body, Controller, Post, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SettlementsService } from './settlements.service';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';

@Controller('settlements')
@UseGuards(JwtAuthGuard)
export class SettlementsController {
    constructor(private readonly settlementsService: SettlementsService) {}

    /**
     * 查询结算批次数据
     * POST /settlements/batches
     * body: { type: 'EXPERIENCE_3DAY' | 'MONTHLY_REGULAR', start?, end? }
     */
    @Post('batches')
    @UseGuards(PermissionsGuard)
    @Permissions('settlements:experience:page', 'settlements:monthly:page')
    queryBatches(@Body() body: any) {
        return this.settlementsService.queryBatch(body);
    }

    /**
     * 标记打款
     * POST /settlements/mark-paid
     * body: { settlementIds: number[], remark? }
     */
    @Post('mark-paid')
    @UseGuards(PermissionsGuard)
    @Permissions('settlements:experience:page', 'settlements:monthly:page')
    markPaid(@Body() body: any, @Request() req: any) {
        return this.settlementsService.markPaid(
            body.settlementIds || [],
            req.user?.userId,
            body.remark,
        );
    }
}
