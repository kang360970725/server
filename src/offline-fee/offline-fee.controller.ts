import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { OfflineFeeService } from './offline-fee.service';
import { QueryOfflineFeeBillsDto } from './dto/query-offline-fee-bills.dto';
import { EnforceOfflineFeeBillDto } from './dto/enforce-offline-fee-bill.dto';
import { PayOfflineFeeBillDto } from './dto/pay-offline-fee-bill.dto';
import { QueryOfflineStaffOptionsDto } from './dto/query-offline-staff-options.dto';
import { ManualCreateOfflineFeeBillDto } from './dto/manual-create-offline-fee-bill.dto';
import { UpdateOfflineFeeBillDto } from './dto/update-offline-fee-bill.dto';

const FINANCE_RECORDS_PAGE = 'finance:records:list';
const FINANCE_OFFLINE_FEES_PAGE = 'finance:offline-fees:page';

@Controller('offline-fees')
@UseGuards(JwtAuthGuard)
export class OfflineFeeController {
  constructor(private readonly service: OfflineFeeService) {}

  @Post('contracts/list')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async listContracts(@Body() dto: any) {
    return this.service.listContracts(dto);
  }

  @Post('contracts/create')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async createContract(@Body() dto: any, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.createContract(dto, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('contracts/update')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async updateContract(@Body() dto: any, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.updateContract(dto, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('bills/list')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async list(@Body() dto: QueryOfflineFeeBillsDto) {
    return this.service.listBills(dto);
  }

  @Post('bills/generate')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async generate(@Body() body: { month: string; confirmed?: boolean }, @Req() req: any) {
    if (body?.confirmed !== true) {
      throw new BadRequestException('生成线下费用账单前请先确认');
    }
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.generateBillsForMonth(body.month, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('staff/offline-options')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async offlineStaffOptions(@Body() dto: QueryOfflineStaffOptionsDto) {
    return this.service.listOfflineStaffOptions(dto.keyword);
  }

  @Post('bills/manual-entry')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async manualEntry(@Body() dto: ManualCreateOfflineFeeBillDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.manualCreateBill(dto, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('bills/update')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async updateBill(@Body() dto: UpdateOfflineFeeBillDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.updateBill(dto, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('bills/enforce')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async enforce(@Body() dto: EnforceOfflineFeeBillDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.setEnforceFullPayment(Number(dto.billId), Boolean(dto.enforceFullPayment), Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('bills/remind')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async remind(@Body() body: { billId: number }, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.remindBill(Number(body.billId), Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('bills/pay')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async pay(@Body() dto: PayOfflineFeeBillDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.collectByWalletBalance({
      billId: Number(dto.billId),
      amount: Number(dto.amount),
      operatorId: Number.isFinite(operatorId) ? operatorId : undefined,
      remark: dto.remark,
    });
  }

  @Post('bills/confirm-paid-external')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async confirmPaidExternal(@Body() dto: PayOfflineFeeBillDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.confirmPaidByOtherChannel({
      billId: Number(dto.billId),
      amount: Number(dto.amount),
      operatorId: Number.isFinite(operatorId) ? operatorId : undefined,
      remark: dto.remark,
    });
  }

  @Post('bills/waive')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async waive(@Body() body: { billId: number; remark?: string }, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.waiveBill({
      billId: Number(body.billId),
      operatorId: Number.isFinite(operatorId) ? operatorId : undefined,
      remark: body?.remark,
    });
  }

  @Post('bills/delete')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async deleteBill(@Body() body: { billId: number }, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.deleteWaivedBill({
      billId: Number(body.billId),
      operatorId: Number.isFinite(operatorId) ? operatorId : undefined,
    });
  }

  @Post('bills/batch-delete')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async batchDeleteBills(@Body() body: { billIds: number[] }, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.batchDeleteBills({
      billIds: Array.isArray(body?.billIds) ? body.billIds : [],
      operatorId: Number.isFinite(operatorId) ? operatorId : undefined,
    });
  }

  @Post('bills/refund')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_OFFLINE_FEES_PAGE, FINANCE_RECORDS_PAGE)
  async refund(@Body() body: { billId: number; remark?: string }, @Req() req: any) {
    void body;
    void req;
    throw new BadRequestException('线下费用回退功能已停用');
  }

  @Post('withdrawal/guard-info')
  async guardInfo(@Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.getWithdrawalGuardInfo(userId);
  }

  @Get('my/pending')
  async listMyPending(@Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.listMyBills(userId);
  }

  @Post('my/confirm')
  async confirmMyBill(@Body() body: { billId: number }, @Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.confirmMyBill(userId, Number(body?.billId));
  }
}
