import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { RentalOrdersService } from './rental-orders.service';
import { CreateAdminRentalOrderDto, SettleAdminRentalOrderDto } from './dto/admin-rental-order.dto';

// 未来自助端使用独立controller与DTO，不开放管理端代扣权限。
@Controller('admin/rental-orders')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminRentalOrdersController {
  constructor(private readonly service: RentalOrdersService) {}
  private operator(req: any) {
    const id = Number(req.user?.userId ?? req.user?.id ?? req.user?.sub);
    if (!Number.isSafeInteger(id) || id <= 0) throw new UnauthorizedException();
    return id;
  }
  @Get()
  @Permissions('rental-orders:page')
  list(@Query() query: any) { return this.service.list(query); }

  @Get(':id')
  @Permissions('rental-orders:page')
  detail(@Param('id', ParseIntPipe) id: number) { return this.service.detail(id); }

  @Post()
  @Permissions('rental-orders:create:button')
  create(@Body() body: CreateAdminRentalOrderDto, @Req() req: any) { return this.service.create(body, this.operator(req)); }

  @Post(':id/settle')
  @Permissions('rental-orders:settle:button')
  settle(@Param('id', ParseIntPipe) id: number, @Body() body: SettleAdminRentalOrderDto, @Req() req: any) {
    return this.service.settle(id, body, this.operator(req));
  }
  @Post(':id/void')
  @Permissions('rental-orders:void:button')
  void(@Param('id', ParseIntPipe) id: number, @Body() body: { version: number; reason: string }, @Req() req: any) {
    return this.service.void(id, body, this.operator(req));
  }
}
