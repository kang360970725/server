import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { SystemConfigService } from './system-config.service';
import { UpsertSystemConfigDto } from './dto/upsert-system-config.dto';
import { StaffRuleEngineService } from './staff-rule-engine.service';

const LEGACY_SYSTEM_ADMIN_PAGE = 'system:role:page';
const SYSTEM_CONFIGS_PAGE = 'system:configs:page';
const MINIAPP_HOME_PAGE = 'miniapp:home:page';
const MINIAPP_CUSTOMER_SERVICE_PAGE = 'miniapp:customer-service:page';

@Controller('system-configs')
export class SystemConfigController {
  constructor(
    private readonly service: SystemConfigService,
    private readonly staffRuleEngineService: StaffRuleEngineService,
  ) {}

  @Post('list')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions(SYSTEM_CONFIGS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async list() {
    await this.service.ensureDefaults();
    return this.service.listAll();
  }

  @Post('upsert')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions(SYSTEM_CONFIGS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async upsert(@Body() dto: UpsertSystemConfigDto) {
    return this.service.upsert(dto);
  }

  @Post('miniapp/home-config/get')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions(MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async getMiniappHomeConfig() {
    return this.service.getMiniappHomeConfig();
  }

  @Post('miniapp/home-config/published/get')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions(MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async getMiniappHomePublishedConfig() {
    return this.service.getMiniappHomePublishedConfig();
  }

  @Post('miniapp/home-config/upsert')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions(MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async upsertMiniappHomeConfig(@Body() body: { config: any }) {
    return this.service.upsertMiniappHomeConfig(body?.config || {});
  }

  @Post('miniapp/home-config/publish')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions(MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async publishMiniappHomeConfig() {
    return this.service.publishMiniappHomeConfig();
  }

  @Post('miniapp/home-staff-candidates')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions(MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async listHomeStaffCandidates(@Body() body: { keyword?: string }) {
    return this.service.listHomeStaffCandidates(body?.keyword);
  }

  @Post('miniapp/home-product-candidates')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions(MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async listHomeProductCandidates(@Body() body: { keyword?: string }) {
    return this.service.listHomeProductCandidates(body?.keyword);
  }

  @Post('goods/category-tree/get')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('system:game-project:page')
  async getGoodsCategoryTree() {
    return this.service.getGoodsCategoryTree();
  }

  @Post('goods/category-tree/upsert')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('system:game-project:page')
  async upsertGoodsCategoryTree(@Body() body: { tree: any[] }) {
    return this.service.upsertGoodsCategoryTree(body?.tree || []);
  }

  @Post('goods/tag-list/get')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('system:game-project:page')
  async getGoodsTagList() {
    return this.service.getGoodsTagList();
  }

  @Post('goods/tag-list/upsert')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('system:game-project:page')
  async upsertGoodsTagList(@Body() body: { tags: any[] }) {
    return this.service.upsertGoodsTagList(body?.tags || []);
  }

  @Post('staff-rule-engine/get')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('users:staff:page', 'users:staff-rental-risk:page', SYSTEM_CONFIGS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async getStaffRuleEngine() {
    await this.service.ensureDefaults();
    return this.staffRuleEngineService.getConfig();
  }

  @Post('staff-rule-engine/upsert')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('users:staff:page', SYSTEM_CONFIGS_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async upsertStaffRuleEngine(@Body() body: { config?: any }) {
    return this.staffRuleEngineService.upsertConfig(body?.config || {});
  }

  @Post('miniapp/customer-service/get')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions(MINIAPP_CUSTOMER_SERVICE_PAGE, MINIAPP_HOME_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async getMiniappCustomerServiceConfig() {
    return this.service.getMiniappCustomerServiceConfig();
  }

  @Post('miniapp/customer-service/upsert')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions(MINIAPP_CUSTOMER_SERVICE_PAGE, LEGACY_SYSTEM_ADMIN_PAGE)
  async upsertMiniappCustomerServiceConfig(@Body() body: { config: any }) {
    return this.service.upsertMiniappCustomerServiceConfig(body?.config || {});
  }

  @Post('miniapp/customer-service/public/get')
  @Public()
  async getPublicMiniappCustomerServiceConfig() {
    return this.service.getMiniappCustomerServiceConfig();
  }
}
