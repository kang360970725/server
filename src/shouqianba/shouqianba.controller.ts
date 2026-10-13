import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ShouqianbaService } from './shouqianba.service';

@Controller('shouqianba')
export class ShouqianbaController {
  constructor(private readonly service: ShouqianbaService) {}

  @Get('status')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('system:configs:page')
  status() {
    return this.service.terminalStatus();
  }

  @Post('activate')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('system:configs:page')
  activate(@Body() body: any) {
    return this.service.activate(body?.code, body?.confirm === true);
  }

  @Post('checkin')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('system:configs:page')
  checkin() {
    return this.service.checkin();
  }

  @Post('query')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('orders:list:page', 'orders:detail:page')
  query(@Body() body: any) {
    return this.service.queryPayment(Number(body?.paymentId));
  }

  @Post('notify')
  @Public()
  async notify(
    @Req() req: RawBodyRequest<Request>,
    @Headers('authorization') authorization: string,
    @Body() body: any,
  ) {
    return this.service.handleCallback(
      req.rawBody || Buffer.alloc(0),
      authorization,
      body,
    );
  }
}
