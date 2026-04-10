import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { OfflineFeeService } from './offline-fee.service';
import { QueryOfflineFeeBillsDto } from './dto/query-offline-fee-bills.dto';
import { EnforceOfflineFeeBillDto } from './dto/enforce-offline-fee-bill.dto';
import { PayOfflineFeeBillDto } from './dto/pay-offline-fee-bill.dto';

@Controller('offline-fees')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class OfflineFeeController {
  constructor(private readonly service: OfflineFeeService) {}

  @Post('bills/list')
  @Permissions('finance:records:list')
  async list(@Body() dto: QueryOfflineFeeBillsDto) {
    return this.service.listBills(dto);
  }

  @Post('bills/generate')
  @Permissions('finance:records:list')
  async generate(@Body() body: { month: string }) {
    return this.service.generateBillsForMonth(body.month);
  }

  @Post('bills/enforce')
  @Permissions('finance:records:list')
  async enforce(@Body() dto: EnforceOfflineFeeBillDto) {
    return this.service.setEnforceFullPayment(Number(dto.billId), Boolean(dto.enforceFullPayment));
  }

  @Post('bills/remind')
  @Permissions('finance:records:list')
  async remind(@Body() body: { billId: number }) {
    return this.service.remindBill(Number(body.billId));
  }

  @Post('bills/pay')
  @Permissions('finance:records:list')
  async pay(@Body() dto: PayOfflineFeeBillDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.collectByWalletBalance({
      billId: Number(dto.billId),
      amount: Number(dto.amount),
      operatorId: Number.isFinite(operatorId) ? operatorId : undefined,
      remark: dto.remark,
    });
  }

  @Post('withdrawal/guard-info')
  async guardInfo(@Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.getWithdrawalGuardInfo(userId);
  }
}
