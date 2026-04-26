import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { AppVersionService } from './app-version.service';
import { UpsertAppVersionDto } from './dto/upsert-app-version.dto';
import { SetActiveBuildDto } from './dto/set-active-build.dto';

const LEGACY_ADMIN_PAGE = 'system:role:page';

@Controller('app-version')
export class AppVersionController {
  constructor(private readonly service: AppVersionService) {}

  @Public()
  @Get('public/latest')
  async latestPublic() {
    return this.service.getLatestPublic();
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Post('list')
  @Permissions(LEGACY_ADMIN_PAGE)
  async list() {
    return this.service.listAll();
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Post('upsert')
  @Permissions(LEGACY_ADMIN_PAGE)
  async upsert(@Body() dto: UpsertAppVersionDto, @Req() req: any) {
    const operatorId = Number(req?.user?.id ?? req?.user?.userId ?? req?.user?.sub);
    return this.service.upsert(dto, operatorId || undefined);
  }

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Post('activate')
  @Permissions(LEGACY_ADMIN_PAGE)
  async activate(@Body() dto: SetActiveBuildDto) {
    return this.service.activateBuild(dto.buildId);
  }
}

