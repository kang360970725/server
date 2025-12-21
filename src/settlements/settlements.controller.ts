// src/settlements/settlements.controller.ts
import { Body, Controller, Post, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SettlementsService } from './settlements.service';

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
    queryBatches(@Body() body: any) {
        return this.settlementsService.queryBatch(body);
    }

    /**
     * 标记打款
     * POST /settlements/mark-paid
     * body: { settlementIds: number[], remark? }
     */
    @Post('mark-paid')
    markPaid(@Body() body: any, @Request() req: any) {
        return this.settlementsService.markPaid(body.settlementIds || [], req.user?.userId, body.remark);
    }
}
