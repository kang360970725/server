import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SystemConfigService } from '../system-config/system-config.service';
import { miniOk } from './mini.response';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('mini-home')
@Controller('mini/home')
export class MiniHomeController {
  constructor(private readonly systemConfigService: SystemConfigService) {}

  private buildEnabledCategoryTree(nodes: any[]): any[] {
    const list = Array.isArray(nodes) ? nodes : []
    return list
      .filter((x) => x?.enabled !== false)
      .map((x) => ({
        id: String(x?.id || ''),
        name: String(x?.name || '').trim(),
        level: Number(x?.level || 1),
        coverImage: x?.coverImage ? String(x.coverImage) : undefined,
        children: this.buildEnabledCategoryTree(Array.isArray(x?.children) ? x.children : []),
      }))
      .filter((x) => x.id && x.name)
  }

  private pickGameCategories(tree: any[]): Array<{ id: string; name: string; coverImage?: string }> {
    const roots = Array.isArray(tree) ? tree : []
    const enabledOnly = (arr: any[]) => arr.filter((x) => x?.enabled !== false)
    const gameRoot = enabledOnly(roots).find((x) => String(x?.name || '').trim() === '游戏类')

    if (gameRoot && Array.isArray(gameRoot?.children)) {
      return enabledOnly(gameRoot.children).map((x: any) => ({
        id: String(x?.id || ''),
        name: String(x?.name || '').trim(),
        coverImage: x?.coverImage ? String(x.coverImage) : undefined,
      })).filter((x) => x.id && x.name)
    }

    return enabledOnly(roots).map((x: any) => ({
      id: String(x?.id || ''),
      name: String(x?.name || '').trim(),
      coverImage: x?.coverImage ? String(x.coverImage) : undefined,
    })).filter((x) => x.id && x.name)
  }

  @Get('config')
  @Public()
  @ApiOperation({ summary: '获取首页配置' })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: {
          banners: [],
          hotSales: [],
          limitedBenefits: [],
          recommendedStaff: [],
          hotEvents: [],
          quickEntries: [],
          esportsGoods: [],
        },
      },
    },
  })
  async config() {
    const data = await this.systemConfigService.getMiniappHomePublishedConfig();
    return miniOk(data);
  }

  @Get('game-categories')
  @Public()
  @ApiOperation({ summary: '获取首页游戏分类（优先返回“游戏类”下子分类）' })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: [{ id: 'gc_xxx', name: '王者荣耀', coverImage: 'https://...' }],
      },
    },
  })
  async gameCategories() {
    const tree = await this.systemConfigService.getGoodsCategoryTree();
    return miniOk(this.pickGameCategories(Array.isArray(tree) ? tree : []));
  }

  @Get('categories')
  @Public()
  @ApiOperation({ summary: '获取商品分类树（仅启用节点）' })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: [{ id: 'gc_1', name: '游戏类', level: 1, children: [{ id: 'gc_2', name: 'MOBA', level: 2 }] }],
      },
    },
  })
  async categories() {
    const tree = await this.systemConfigService.getGoodsCategoryTree();
    return miniOk(this.buildEnabledCategoryTree(Array.isArray(tree) ? tree : []));
  }
}
