import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { SystemConfigService } from './system-config.service';
import { UpsertSystemConfigDto } from './dto/upsert-system-config.dto';
import { StaffRuleEngineService } from './staff-rule-engine.service';

const LEGACY_SYSTEM_ADMIN_PAGE = 'system:role:page';
const SYSTEM_CONFIGS_PAGE = 'system:configs:page';
const MINIAPP_HOME_PAGE = 'miniapp:home:page';

@Controller('system-configs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SystemConfigController {
  constructor(
    private readonly service: SystemConfigService,
    private readonly staffRuleEngineService: StaffRuleEngineService,
  ) {}

  @Post('list')
  @Permissions(SYSTEM_CONFIGS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async list() {
    await this.service.ensureDefaults();
    return this.service.listAll();
  }

  @Post('upsert')
  @Permissions(SYSTEM_CONFIGS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async upsert(@Body() dto: UpsertSystemConfigDto) {
    return this.service.upsert(dto);
  }

  @Post('miniapp/home-config/get')
  @Permissions(MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async getMiniappHomeConfig() {
    return this.service.getMiniappHomeConfig();
  }

  @Post('miniapp/home-config/published/get')
  @Permissions(MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async getMiniappHomePublishedConfig() {
    return this.service.getMiniappHomePublishedConfig();
  }

  @Post('miniapp/home-config/upsert')
  @Permissions(MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async upsertMiniappHomeConfig(@Body() body: { config: any }) {
    return this.service.upsertMiniappHomeConfig(body?.config || {});
  }

  @Post('miniapp/home-config/publish')
  @Permissions(MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async publishMiniappHomeConfig() {
    return this.service.publishMiniappHomeConfig();
  }

  @Post('miniapp/home-staff-candidates')
  @Permissions(MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async listHomeStaffCandidates(@Body() body: { keyword?: string }) {
    return this.service.listHomeStaffCandidates(body?.keyword);
  }

  @Post('miniapp/home-product-candidates')
  @Permissions(MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
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

  @Post('staff-rule-engine/get')
  @Permissions('users:staff:page', SYSTEM_CONFIGS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async getStaffRuleEngine() {
    await this.service.ensureDefaults();
    return this.staffRuleEngineService.getConfig();
  }

  @Post('staff-rule-engine/upsert')
  @Permissions('users:staff:page', SYSTEM_CONFIGS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async upsertStaffRuleEngine(@Body() body: { config?: any }) {
    return this.staffRuleEngineService.upsertConfig(body?.config || {});
  }
}
