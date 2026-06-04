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

  @Post('miniapp/home-config/get')
  @Permissions('system:role:page')
  async getMiniappHomeConfig() {
    return this.service.getMiniappHomeConfig();
  }

  @Post('miniapp/home-config/published/get')
  @Permissions('system:role:page')
  async getMiniappHomePublishedConfig() {
    return this.service.getMiniappHomePublishedConfig();
  }

  @Post('miniapp/home-config/upsert')
  @Permissions('system:role:page')
  async upsertMiniappHomeConfig(@Body() body: { config: any }) {
    return this.service.upsertMiniappHomeConfig(body?.config || {});
  }

  @Post('miniapp/home-config/publish')
  @Permissions('system:role:page')
  async publishMiniappHomeConfig() {
    return this.service.publishMiniappHomeConfig();
  }

  @Post('miniapp/home-staff-candidates')
  @Permissions('system:role:page')
  async listHomeStaffCandidates(@Body() body: { keyword?: string }) {
    return this.service.listHomeStaffCandidates(body?.keyword);
  }

  @Post('miniapp/home-product-candidates')
  @Permissions('system:role:page')
  async listHomeProductCandidates(@Body() body: { keyword?: string }) {
    return this.service.listHomeProductCandidates(body?.keyword);
  }

  @Post('goods/category-tree/get')
  @Permissions('system:game-project:page')
  async getGoodsCategoryTree() {
    return this.service.getGoodsCategoryTree();
  }

  @Post('goods/category-tree/upsert')
  @Permissions('system:game-project:page')
  async upsertGoodsCategoryTree(@Body() body: { tree: any[] }) {
    return this.service.upsertGoodsCategoryTree(body?.tree || []);
  }

  @Post('goods/tag-list/get')
  @Permissions('system:game-project:page')
  async getGoodsTagList() {
    return this.service.getGoodsTagList();
  }

  @Post('goods/tag-list/upsert')
  @Permissions('system:game-project:page')
  async upsertGoodsTagList(@Body() body: { tags: any[] }) {
    return this.service.upsertGoodsTagList(body?.tags || []);
  }
}
