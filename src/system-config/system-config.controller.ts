import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { SystemConfigService } from './system-config.service';
import { UpsertSystemConfigDto } from './dto/upsert-system-config.dto';

@Controller('system-configs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SystemConfigController {
  constructor(private readonly service: SystemConfigService) {}

  @Post('list')
  @Permissions('system:role:page')
  async list() {
    await this.service.ensureDefaults();
    return this.service.listAll();
  }

  @Post('upsert')
  @Permissions('system:role:page')
  async upsert(@Body() dto: UpsertSystemConfigDto) {
    return this.service.upsert(dto);
  }
}
