import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { EquipmentRentalFeeService } from './equipment-rental-fee.service';

const FINANCE_RECORDS_PAGE = 'finance:records:list';
const FINANCE_EQUIPMENT_RENTAL_FEES_PAGE = 'finance:equipment-rental-fees:page';

@Controller('equipment-rental-fees')
@UseGuards(JwtAuthGuard)
export class EquipmentRentalFeeController {
  constructor(private readonly service: EquipmentRentalFeeService) {}

  @Post('contracts/list')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_EQUIPMENT_RENTAL_FEES_PAGE, FINANCE_RECORDS_PAGE)
  listContracts(@Body() body: any) {
    return this.service.listContracts(body);
  }

  @Post('contracts/create')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_EQUIPMENT_RENTAL_FEES_PAGE, FINANCE_RECORDS_PAGE)
  createContract(@Body() body: any, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.createContract(body, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('contracts/update')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_EQUIPMENT_RENTAL_FEES_PAGE, FINANCE_RECORDS_PAGE)
  updateContract(@Body() body: any) {
    return this.service.updateContract(body);
  }

  @Post('bills/list')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_EQUIPMENT_RENTAL_FEES_PAGE, FINANCE_RECORDS_PAGE)
  listBills(@Body() body: any) {
    return this.service.listBills(body);
  }

  @Post('bills/generate')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_EQUIPMENT_RENTAL_FEES_PAGE, FINANCE_RECORDS_PAGE)
  generateBills(@Body() body: any) {
    return this.service.generateBillsForMonth(body?.month);
  }

  @Post('bills/waive')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_EQUIPMENT_RENTAL_FEES_PAGE, FINANCE_RECORDS_PAGE)
  waiveBill(@Body() body: any) {
    return this.service.waiveBill(Number(body?.billId), body?.remark);
  }

  @Post('bills/pay')
  @UseGuards(PermissionsGuard)
  @Permissions(FINANCE_EQUIPMENT_RENTAL_FEES_PAGE, FINANCE_RECORDS_PAGE)
  payBill(@Body() body: any, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.payBillByAdmin(Number(body?.billId), Number.isFinite(operatorId) ? operatorId : undefined, body?.remark);
  }

  @Get('my/pending')
  listMyPending(@Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.listMyBills(userId);
  }

  @Post('my/confirm')
  confirmMyBill(@Body() body: any, @Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.confirmMyBill(userId, Number(body?.billId));
  }
}
