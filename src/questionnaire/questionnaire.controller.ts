import { Body, Controller, Get, Param, ParseIntPipe, Post, Req, UseGuards } from '@nestjs/common';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { QuestionnaireService } from './questionnaire.service';

@Controller('questionnaires')
export class QuestionnaireController {
  constructor(private readonly service: QuestionnaireService) {}

  @Post('admin/list')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('system:role:page')
  adminList(@Body() body: any) {
    return this.service.adminList(body || {});
  }

  @Post('admin/create')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('system:role:page')
  adminCreate(@Body() body: any, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.adminCreate(body || {}, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Post('admin/update')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('system:role:page')
  adminUpdate(@Body() body: any, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.adminUpdate(body || {}, Number.isFinite(operatorId) ? operatorId : undefined);
  }

  @Get('admin/:id')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('system:role:page')
  adminDetail(@Param('id', ParseIntPipe) id: number) {
    return this.service.adminDetail(id);
  }

  @Get('my/available')
  @UseGuards(JwtAuthGuard)
  myAvailable(@Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.listAvailableForUser(userId);
  }

  @Get('my/:id')
  @UseGuards(JwtAuthGuard)
  myDetail(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.userDetail(id, userId);
  }

  @Post('my/:id/submit')
  @UseGuards(JwtAuthGuard)
  mySubmit(@Param('id', ParseIntPipe) id: number, @Req() req: any, @Body() body: any) {
    const userId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.submitForUser(id, userId, body || {}, this.service.extractRequestMeta(req));
  }

  @Get('public/available')
  @Public()
  publicAvailable() {
    return this.service.listPublicAvailable();
  }

  @Get('public/:id')
  @Public()
  publicDetail(@Param('id', ParseIntPipe) id: number) {
    return this.service.publicDetail(id);
  }

  @Post('public/:id/submit')
  @Public()
  publicSubmit(@Param('id', ParseIntPipe) id: number, @Req() req: any, @Body() body: any) {
    return this.service.submitForGuest(id, body || {}, this.service.extractRequestMeta(req));
  }
}
