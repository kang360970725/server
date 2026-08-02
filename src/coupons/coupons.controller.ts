import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { CouponsService } from './coupons.service';
import { CreateCouponTemplateDto } from './dto/create-coupon-template.dto';
import { UpdateCouponTemplateStatusDto } from './dto/update-coupon-template-status.dto';
import { GrantUserCouponDto } from './dto/grant-user-coupon.dto';

const LEGACY_ADMIN_PAGE = 'system:role:page';
const ORDERS_PAGE = 'orders:list:page';
const USER_COUPONS_LIST = 'coupons:user-coupons:list';
const COUPONS_PAGE = 'coupons:page';

@Controller('coupons')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Post('templates/list')
  @Permissions(COUPONS_PAGE, LEGACY_ADMIN_PAGE)
  listTemplates(@Body() body: any) {
    return this.couponsService.listTemplates(body || {});
  }

  @Post('templates/create')
  @Permissions(COUPONS_PAGE, LEGACY_ADMIN_PAGE)
  createTemplate(@Body() dto: CreateCouponTemplateDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.couponsService.createTemplate(dto, operatorId);
  }

  @Post('templates/update-status')
  @Permissions(COUPONS_PAGE, LEGACY_ADMIN_PAGE)
  updateTemplateStatus(@Body() dto: UpdateCouponTemplateStatusDto) {
    return this.couponsService.updateTemplateStatus(dto);
  }

  @Post('grant')
  @Permissions(COUPONS_PAGE, LEGACY_ADMIN_PAGE)
  grant(@Body() dto: GrantUserCouponDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.couponsService.grantUserCoupon(dto, operatorId);
  }

  @Post('user-coupons/list')
  @Permissions(COUPONS_PAGE, USER_COUPONS_LIST, ORDERS_PAGE, LEGACY_ADMIN_PAGE)
  listUserCoupons(@Body() body: any) {
    return this.couponsService.listUserCoupons(body || {});
  }
}
