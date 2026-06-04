import { BadRequestException, Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ProjectStatus } from '@prisma/client';
import { ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { miniOk } from './mini.response';
import { Public } from '../auth/decorators/public.decorator';

@ApiTags('mini-projects')
@Controller('mini/projects')
export class MiniProjectsController {
  constructor(private readonly prisma: PrismaService, private readonly systemConfigService: SystemConfigService) {}

  private buildCategoryNameMap(nodes: any[]): Map<string, string> {
    const map = new Map<string, string>();
    const walk = (list: any[]) => {
      (list || []).forEach((n) => {
        const id = String(n?.id || '').trim();
        const name = String(n?.name || '').trim();
        if (id && name) map.set(id, name);
        if (Array.isArray(n?.children)) walk(n.children);
      });
    };
    walk(Array.isArray(nodes) ? nodes : []);
    return map;
  }

  private buildTagNameMap(tags: any[]): Map<string, string> {
    const map = new Map<string, string>();
    (Array.isArray(tags) ? tags : []).forEach((t) => {
      const id = String(t?.id || '').trim();
      const name = String(t?.name || '').trim();
      if (id && name) map.set(id, name);
    });
    return map;
  }

  private async getProjectRatingStats(projectIds: number[]) {
    const ids = Array.from(new Set((projectIds || []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)));
    const map = new Map<number, { ratingAvg: number; ratingCount: number }>();
    if (!ids.length) return map;
    const rows = await this.prisma.productReview.findMany({
      where: { projectId: { in: ids }, isHidden: false },
      select: { projectId: true, score: true },
    });
    const bucket = new Map<number, { sum: number; cnt: number }>();
    rows.forEach((r) => {
      const b = bucket.get(r.projectId) || { sum: 0, cnt: 0 };
      b.sum += Number(r.score || 0);
      b.cnt += 1;
      bucket.set(r.projectId, b);
    });
    ids.forEach((id) => {
      const b = bucket.get(id);
      if (!b || !b.cnt) map.set(id, { ratingAvg: 5.0, ratingCount: 0 });
      else map.set(id, { ratingAvg: Number((b.sum / b.cnt).toFixed(2)), ratingCount: b.cnt });
    });
    return map;
  }

  private async getActiveDiscountProductMap() {
    const row = await this.prisma.systemConfig.findUnique({
      where: { key: 'miniapp_home_config_published' },
      select: { value: true },
    });
    if (!row?.value) return new Map<number, any>();
    let config: any = {};
    try {
      config = JSON.parse(String(row.value || '{}'));
    } catch {
      return new Map<number, any>();
    }
    const now = Date.now();
    const map = new Map<number, any>();
    const list = Array.isArray(config?.limitedBenefits) ? config.limitedBenefits : [];
    for (const item of list) {
      const activityType = String(item?.activityType || '').toLowerCase();
      const targetType = String(item?.targetType || '').toLowerCase();
      const targetValue = Number(item?.targetValue || 0);
      if (activityType !== 'discount' || targetType !== 'product' || !targetValue) continue;
      const startAt = item?.startAt ? new Date(item.startAt).getTime() : 0;
      const durationText = String(item?.durationHours ?? '').trim();
      const durationHours = Number(item?.durationHours);
      const longTermRaw = item?.isLongTerm;
      const isLongTerm =
        longTermRaw === true ||
        String(longTermRaw ?? '').toLowerCase() === 'true' ||
        String(longTermRaw ?? '').toLowerCase() === '1' ||
        !durationText ||
        !Number.isFinite(durationHours) ||
        durationHours <= 0;

      if (startAt && Number.isFinite(startAt) && now < startAt) continue;
      if (!isLongTerm && startAt && Number.isFinite(startAt)) {
        const endAt = startAt + durationHours * 3600 * 1000;
        if (now > endAt) continue;
      }
      map.set(targetValue, item);
    }
    return map;
  }

  @Get()
  @Public()
  @ApiOperation({ summary: '项目列表' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'category', required: false, example: 'MOBA' })
  @ApiQuery({ name: 'gameType', required: false, example: '王者荣耀' })
  @ApiQuery({ name: 'projectType', required: false, example: '排位上分' })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: { list: [], total: 0, page: 1, limit: 20, totalPages: 0 },
      },
    },
  })
  async list(@Query() query: any) {
    const page = Math.max(1, Number(query?.page ?? 1));
    const limit = Math.min(500, Math.max(1, Number(query?.limit ?? 20)));
    const skip = (page - 1) * limit;

    const discountMap = await this.getActiveDiscountProductMap();
    const hiddenIds = Array.from(discountMap.keys());
    const where: any = { status: ProjectStatus.ACTIVE };
    if (hiddenIds.length) {
      where.id = { notIn: hiddenIds };
    }

    const and: any[] = [];
    const category = String(query?.category || '').trim();
    const gameType = String(query?.gameType || '').trim();
    const projectType = String(query?.projectType || '').trim();
    const keyword = String(query?.keyword || '').trim();

    // 兼容前端以分类名筛选（一级/二级都可能传），避免必须精确匹配单字段
    if (category) {
      and.push({
        OR: [
          { category: { contains: category } },
          { gameType: { contains: category } },
          { projectType: { contains: category } },
        ],
      });
    }
    if (gameType) {
      and.push({
        OR: [{ gameType: { contains: gameType } }, { category: { contains: gameType } }],
      });
    }
    if (projectType) {
      and.push({
        OR: [{ projectType: { contains: projectType } }, { category: { contains: projectType } }],
      });
    }
    if (keyword) {
      and.push({ name: { contains: keyword } });
    }
    if (and.length) {
      where.AND = and;
    }

    const [list, total, categoryTree, tagList] = await Promise.all([
      this.prisma.gameProject.findMany({
        where,
        orderBy: { id: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          price: true,
          type: true,
          gameType: true,
          category: true,
          projectType: true,
          billingMode: true,
          coverImage: true,
          description: true,
        },
      }),
      this.prisma.gameProject.count({ where }),
      this.systemConfigService.getGoodsCategoryTree(),
      this.systemConfigService.getGoodsTagList(),
    ]);

    const categoryNameMap = this.buildCategoryNameMap(categoryTree);
    const tagNameMap = this.buildTagNameMap(tagList);
    const mappedList = list.map((item: any) => {
      const gameTypeId = String(item?.gameType || '').trim();
      const categoryId = String(item?.category || '').trim();
      const resolvedCategoryId = categoryId || gameTypeId;
      const projectTypeIds = String(item?.projectType || '')
        .split(',')
        .map((x) => x.trim())
        .filter((x) => !!x);
      const projectTypeNames = projectTypeIds.map((id) => tagNameMap.get(id) || id);
      return {
        ...item,
        gameTypeId: gameTypeId || null,
        categoryId: resolvedCategoryId || null,
        category: resolvedCategoryId || null,
        gameTypeName: gameTypeId ? categoryNameMap.get(gameTypeId) || null : null,
        categoryName: resolvedCategoryId ? categoryNameMap.get(resolvedCategoryId) || null : null,
        projectTypeNames,
      };
    });

    const ratingMap = await this.getProjectRatingStats(mappedList.map((x: any) => Number(x?.id || 0)));
    const finalList = mappedList.map((item: any) => {
      const st = ratingMap.get(Number(item?.id || 0)) || { ratingAvg: 0, ratingCount: 0 };
      return { ...item, ratingAvg: st.ratingAvg };
    });

    return miniOk({ list: finalList, total, page, limit, totalPages: Math.ceil(total / limit) });
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: '项目详情' })
  @ApiParam({ name: 'id', example: 1 })
  @ApiOkResponse({
    schema: {
      example: { code: 0, message: 'ok', data: { id: 1, name: '王者荣耀陪玩', price: 128 } },
    },
  })
  async detail(@Param('id', ParseIntPipe) id: number) {
    const row = await this.prisma.gameProject.findUnique({
      where: { id },
    });
    if (!row || row.status !== ProjectStatus.ACTIVE) {
      throw new BadRequestException('项目不存在或已下架');
    }
    const discountMap = await this.getActiveDiscountProductMap();
    const discount = discountMap.get(id);
    const st = (await this.getProjectRatingStats([id])).get(id) || { ratingAvg: 0, ratingCount: 0 };
    return miniOk({
      ...row,
      ratingAvg: st.ratingAvg,
      discountOriginPrice: discount?.discountOriginPrice ?? null,
      discountTag: discount?.badge || null,
    });
  }

  @Get(':id/reviews')
  @Public()
  @ApiOperation({ summary: '商品评价列表（仅展示未隐藏）' })
  async reviews(@Param('id', ParseIntPipe) id: number, @Query() query: any) {
    const page = Math.max(1, Number(query?.page ?? 1));
    const limit = Math.min(50, Math.max(1, Number(query?.limit ?? 20)));
    const skip = (page - 1) * limit;
    const [list, total] = await Promise.all([
      this.prisma.productReview.findMany({
        where: { projectId: id, isHidden: false },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
        select: {
          id: true,
          score: true,
          tags: true,
          content: true,
          anonymous: true,
          createdAt: true,
          user: { select: { id: true, name: true } },
        },
      }),
      this.prisma.productReview.count({ where: { projectId: id, isHidden: false } }),
    ]);
    const data = list.map((r) => ({
      id: r.id,
      score: r.score,
      tags: Array.isArray(r.tags as any) ? (r.tags as any) : [],
      content: r.content || '',
      createdAt: r.createdAt,
      userName: r.anonymous ? '匿名用户' : (r.user?.name || `用户${r.user?.id || ''}`),
    }));
    return miniOk({ list: data, total, page, limit, totalPages: Math.ceil(total / limit) });
  }
}
