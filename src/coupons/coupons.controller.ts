import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { CouponsService } from './coupons.service';
import { CreateCouponTemplateDto } from './dto/create-coupon-template.dto';
import { UpdateCouponTemplateStatusDto } from './dto/update-coupon-template-status.dto';
import { GrantUserCouponDto } from './dto/grant-user-coupon.dto';

@Controller('coupons')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  @Post('templates/list')
  @Permissions('system:role:page')
  listTemplates(@Body() body: any) {
    return this.couponsService.listTemplates(body || {});
  }

  @Post('templates/create')
  @Permissions('system:role:page')
  createTemplate(@Body() dto: CreateCouponTemplateDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.couponsService.createTemplate(dto, operatorId);
  }

  @Post('templates/update-status')
  @Permissions('system:role:page')
  updateTemplateStatus(@Body() dto: UpdateCouponTemplateStatusDto) {
    return this.couponsService.updateTemplateStatus(dto);
  }

  @Post('grant')
  @Permissions('system:role:page')
  grant(@Body() dto: GrantUserCouponDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.couponsService.grantUserCoupon(dto, operatorId);
  }

  @Post('user-coupons/list')
  @Permissions('system:role:page')
  listUserCoupons(@Body() body: any) {
    return this.couponsService.listUserCoupons(body || {});
  }
}
