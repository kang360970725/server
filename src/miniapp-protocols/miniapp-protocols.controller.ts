import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { MiniappProtocolsService } from './miniapp-protocols.service';
import { UpsertMiniappProtocolDto } from './dto/upsert-miniapp-protocol.dto';
import { UpsertMiniappProtocolCategoryDto } from './dto/upsert-miniapp-protocol-category.dto';
import { miniOk } from '../mini/mini.response';

@Controller('miniapp-protocols')
export class MiniappProtocolsController {
  constructor(private readonly service: MiniappProtocolsService) {}

  @Post('categories/list')
  @UseGuards(PermissionsGuard)
  @Permissions('system:role:page')
  async listCategories() {
    return this.service.listCategories();
  }

  @Post('categories/upsert')
  @UseGuards(PermissionsGuard)
  @Permissions('system:role:page')
  async upsertCategory(@Body() dto: UpsertMiniappProtocolCategoryDto) {
    return this.service.upsertCategory(dto);
  }

  @Post('categories/delete')
  @UseGuards(PermissionsGuard)
  @Permissions('system:role:page')
  async deleteCategory(@Body() body: { id: number }) {
    return this.service.removeCategory(Number(body?.id || 0));
  }

  @Post('list')
  @UseGuards(PermissionsGuard)
  @Permissions('system:role:page')
  async list() {
    return this.service.listAll();
  }

  @Post('upsert')
  @UseGuards(PermissionsGuard)
  @Permissions('system:role:page')
  async upsert(@Body() dto: UpsertMiniappProtocolDto) {
    return this.service.upsert(dto);
  }

  @Post('delete')
  @UseGuards(PermissionsGuard)
  @Permissions('system:role:page')
  async delete(@Body() body: { key: string }) {
    return this.service.remove(body || {});
  }

  @Public()
  @Get('public/list-by-category')
  async listPublicByCategory(@Query('category') category: string) {
    return miniOk(await this.service.listPublicByCategoryName(category));
  }

  @Public()
  @Post('public')
  async listPublicByKeys(@Body() body: { keys?: string | string[] }) {
    return miniOk(await this.service.listPublicByKeys(body?.keys || []));
  }

  @Public()
  @Get('public/:key')
  async getPublic(@Param('key') key: string) {
    return miniOk(await this.service.getByKey(key));
  }
}
