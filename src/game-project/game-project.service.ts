import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGameProjectDto, UpdateGameProjectDto } from './dto/game-project.dto';
import { OrderType, ProjectStatus, BillingMode } from '@prisma/client';
import { tcbGetUploadInfo } from '../common/cloudbase.storage';
import { SystemConfigService } from '../system-config/system-config.service';

@Injectable()
export class GameProjectService {
    constructor(
        private prisma: PrismaService,
        private readonly systemConfigService: SystemConfigService,
    ) {}

    private normalizeGuaranteedSettlementPolicy(input: any) {
        const mode = String(input?.guaranteedSettlementMode || 'STANDARD').trim().toUpperCase();
        if (!['STANDARD', 'FINAL_ROUND_TAKES_ALL'].includes(mode)) {
            throw new BadRequestException('保底结算策略无效');
        }
        const rawMinimum = input?.minimumFinalProgressWan;
        const minimum = rawMinimum === null || rawMinimum === undefined || rawMinimum === '' ? null : Number(rawMinimum);
        if (minimum !== null && (!Number.isFinite(minimum) || minimum < 0)) {
            throw new BadRequestException('最后一组最低保底进度必须大于或等于 0');
        }
        return {
            guaranteedSettlementMode: mode,
            minimumFinalProgressWan: mode === 'FINAL_ROUND_TAKES_ALL' ? null : minimum,
        };
    }

    private buildCategoryNameMap(nodes: any[]): Map<string, string> {
        const map = new Map<string, string>();
        const walk = (arr: any[]) => {
            (arr || []).forEach((node) => {
                const id = String(node?.id || '').trim();
                const name = String(node?.name || '').trim();
                if (id && name) map.set(id, name);
                if (Array.isArray(node?.children)) walk(node.children);
            });
        };
        walk(nodes || []);
        return map;
    }

    private buildTagNameMap(tags: any[]): Map<string, string> {
        const map = new Map<string, string>();
        (tags || []).forEach((tag) => {
            const id = String(tag?.id || '').trim();
            const name = String(tag?.name || '').trim();
            if (id && name) map.set(id, name);
        });
        return map;
    }

    private isBlankCategoryFilter(value?: string) {
        const text = String(value || '').trim();
        return ['__EMPTY__', '__BLANK__', 'EMPTY', 'NULL', 'null'].includes(text);
    }

    private parseBooleanFilter(value: unknown) {
        if (value === true || value === false) return value;
        const text = String(value ?? '').trim().toLowerCase();
        if (['true', '1', 'yes'].includes(text)) return true;
        if (['false', '0', 'no'].includes(text)) return false;
        return undefined;
    }

    async getUploadInfo(params: { filename?: string; scene?: string }) {
        const rawName = String(params?.filename || 'file').trim();
        const safeName = rawName.replace(/[^\w.\-]/g, '_').slice(-80) || 'file';
        const ext = safeName.includes('.') ? safeName.split('.').pop() : 'bin';
        const scene = String(params?.scene || 'detail').trim() || 'detail';
        const date = new Date();
        const y = date.getFullYear();
        const m = `${date.getMonth() + 1}`.padStart(2, '0');
        const d = `${date.getDate()}`.padStart(2, '0');
        const stamp = Date.now();
        const cloudPath = `uploads/game-project/${scene}/${y}${m}${d}/${stamp}.${ext}`;
        return tcbGetUploadInfo({ cloudPath });
    }

    async create(createGameProjectDto: CreateGameProjectDto) {
        const data: any = {
            ...createGameProjectDto,
            type: createGameProjectDto.type as OrderType,
        };

        // ✅ 新增：billingMode 枚举转换（如果前端没传，走 schema 默认值）
        if (createGameProjectDto.billingMode) {
            data.billingMode = createGameProjectDto.billingMode as BillingMode;
        }
        const policy = this.normalizeGuaranteedSettlementPolicy(createGameProjectDto);
        // 非体验保底商品的业务默认值为 800 万；仍可在项目配置中明确改为其他值或全额模式。
        if ((createGameProjectDto.billingMode ?? BillingMode.GUARANTEED) === BillingMode.GUARANTEED
            && String(createGameProjectDto.type) !== 'EXPERIENCE'
            && policy.guaranteedSettlementMode === 'STANDARD'
            && policy.minimumFinalProgressWan === null) {
            policy.minimumFinalProgressWan = 800;
        }
        Object.assign(data, policy);

        return this.prisma.gameProject.create({ data });
    }

    async findAll() {
        return this.prisma.gameProject.findMany({
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
        });
    }

    async list(params: {
        page?: number;
        limit?: number;
        keyword?: string;
        gameType?: string;
        category?: string;
        status?: string;
        showInMenuList?: boolean | string;
    }) {
        const page = Math.max(1, Number(params?.page || 1));
        const limit = Math.min(100, Math.max(1, Number(params?.limit || 20)));
        const skip = (page - 1) * limit;
        const where: any = {};
        const and: any[] = [];

        const keyword = String(params?.keyword || '').trim();
        if (keyword) {
            and.push({ OR: [
                { name: { contains: keyword } },
                { description: { contains: keyword } },
            ] });
        }
        if (this.isBlankCategoryFilter(params?.gameType)) {
            and.push({ OR: [{ gameType: null }, { gameType: '' }] });
        } else if (params?.gameType) {
            where.gameType = String(params.gameType).trim();
        }
        if (this.isBlankCategoryFilter(params?.category)) {
            and.push({ OR: [{ category: null }, { category: '' }] });
        } else if (params?.category) {
            where.category = String(params.category).trim();
        }
        if (params?.status) where.status = String(params.status).trim();
        const showInMenuList = this.parseBooleanFilter(params?.showInMenuList);
        if (showInMenuList !== undefined) where.showInMenuList = showInMenuList;
        if (and.length) where.AND = and;

        const [data, total] = await Promise.all([
            this.prisma.gameProject.findMany({
                where,
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
                skip,
                take: limit,
            }),
            this.prisma.gameProject.count({ where }),
        ]);
        const ids = data.map((x) => Number(x.id)).filter((x) => Number.isFinite(x) && x > 0);
        const ratingRows = ids.length
            ? await this.prisma.productReview.findMany({
                where: { projectId: { in: ids }, isHidden: false },
                select: { projectId: true, score: true },
            })
            : [];
        const bucket = new Map<number, { sum: number; cnt: number }>();
        ratingRows.forEach((r) => {
            const old = bucket.get(r.projectId) || { sum: 0, cnt: 0 };
            old.sum += Number(r.score || 0);
            old.cnt += 1;
            bucket.set(r.projectId, old);
        });
        const merged = data.map((item: any) => {
            const st = bucket.get(Number(item.id));
            return {
                ...item,
                ratingAvg: st?.cnt ? Number((st.sum / st.cnt).toFixed(2)) : 5.0,
                ratingCount: st?.cnt || 0,
            };
        });
        return { data: merged, total, page, limit, totalPages: Math.ceil(total / limit) };
    }

    async findOne(id: number) {
        return this.prisma.gameProject.findUnique({ where: { id } });
    }

    async update(id: number, updateGameProjectDto: UpdateGameProjectDto) {
        const data: any = { ...updateGameProjectDto };

        if (updateGameProjectDto.type) {
            data.type = updateGameProjectDto.type as OrderType;
        }
        if (updateGameProjectDto.status) {
            data.status = updateGameProjectDto.status as ProjectStatus;
        }

        // ✅ 新增：billingMode 枚举转换
        if (updateGameProjectDto.billingMode) {
            data.billingMode = updateGameProjectDto.billingMode as BillingMode;
        }
        if (updateGameProjectDto.guaranteedSettlementMode !== undefined || updateGameProjectDto.minimumFinalProgressWan !== undefined) {
            const existing = await this.prisma.gameProject.findUnique({ where: { id },
                select: { guaranteedSettlementMode: true, minimumFinalProgressWan: true } });
            Object.assign(data, this.normalizeGuaranteedSettlementPolicy({
                guaranteedSettlementMode: updateGameProjectDto.guaranteedSettlementMode ?? existing?.guaranteedSettlementMode,
                minimumFinalProgressWan: updateGameProjectDto.minimumFinalProgressWan !== undefined
                    ? updateGameProjectDto.minimumFinalProgressWan : existing?.minimumFinalProgressWan,
            }));
        }

        return this.prisma.gameProject.update({
            where: { id },
            data,
        });
    }

    async remove(id: number) {
        return this.prisma.gameProject.update({
            where: { id },
            data: { status: 'INACTIVE' },
        });
    }

    async options(params: { keyword?: string; category?: string }) {
        const where: any = { status: 'ACTIVE' };
        if (params?.keyword) {
            where.OR = [{ name: { contains: params.keyword } }];
        }
        if (params?.category) {
            where.category = String(params.category).trim();
        }
        return this.prisma.gameProject.findMany({
            where,
            select: { id: true, name: true, type: true, price: true, baseAmount: true, billingMode: true, category: true,
                guaranteedSettlementMode: true, minimumFinalProgressWan: true },
            orderBy: { id: 'desc' },
            take: 50,
        });
    }

    async publicMenuList(params: {
        keyword?: string;
        gameType?: string;
        projectType?: string;
        category?: string;
        page?: number;
        limit?: number;
    }) {
        const where: any = { status: 'ACTIVE' };
        where.showInMenuList = true;
        if (params?.keyword) {
            where.name = { contains: String(params.keyword).trim() };
        }
        if (params?.gameType) where.gameType = String(params.gameType).trim();
        if (params?.projectType) where.projectType = String(params.projectType).trim();
        if (params?.category) where.category = String(params.category).trim();

        const hasPaging = Number.isFinite(Number(params?.page)) || Number.isFinite(Number(params?.limit));
        const page = hasPaging ? Math.max(1, Number(params?.page || 1)) : 1;
        const limit = hasPaging ? Math.min(30, Math.max(1, Number(params?.limit || 20))) : 0;
        const skip = hasPaging ? (page - 1) * limit : 0;

        const selectFields = {
            id: true,
            name: true,
            price: true,
            originPrice: true,
            type: true,
            billingMode: true,
            baseAmount: true,
            clubRate: true,
            coverImage: true,
            description: true,
            gameType: true,
            projectType: true,
            category: true,
        } as const;

        const listQuery = this.prisma.gameProject.findMany({
            where,
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            ...(hasPaging ? { skip, take: limit } : {}),
            select: selectFields,
        });

        const totalQuery = hasPaging ? this.prisma.gameProject.count({ where }) : Promise.resolve(0);
        const [list, total, categoryTree, tagList, filterRows] = await Promise.all([
            listQuery,
            totalQuery,
            this.systemConfigService.getGoodsCategoryTree(),
            this.systemConfigService.getGoodsTagList(),
            this.prisma.gameProject.findMany({
                where: { status: 'ACTIVE' },
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
                select: {
                    gameType: true,
                    projectType: true,
                    category: true,
                },
            }),
        ]);

        const categoryNameMap = this.buildCategoryNameMap(Array.isArray(categoryTree) ? categoryTree : []);
        const tagNameMap = this.buildTagNameMap(Array.isArray(tagList) ? tagList : []);
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

        const pickTags = (rows: any[], key: 'gameTypeName' | 'categoryName') =>
            Array.from(
                new Set(
                    rows
                        .map((x) => String(x?.[key] || '').trim())
                        .filter((x) => !!x),
                ),
            );
        const pickProjectTypes = (rows: any[]) =>
            Array.from(
                new Set(
                    rows.flatMap((x) =>
                        Array.isArray(x?.projectTypeNames)
                            ? x.projectTypeNames.map((y: any) => String(y || '').trim()).filter(Boolean)
                            : [],
                    ),
                ),
            );

        const filterItems = filterRows.map((item: any) => {
            const gameTypeId = String(item?.gameType || '').trim();
            const categoryId = String(item?.category || '').trim();
            const resolvedCategoryId = categoryId || null;
            const projectTypeIds = String(item?.projectType || '')
                .split(',')
                .map((x) => x.trim())
                .filter((x) => !!x);
            const projectTypeNames = projectTypeIds.map((id) => tagNameMap.get(id) || id);
            return {
                ...item,
                gameTypeId: gameTypeId || null,
                categoryId: resolvedCategoryId || null,
                category: categoryId || null,
                gameTypeName: gameTypeId ? categoryNameMap.get(gameTypeId) || null : null,
                categoryName: resolvedCategoryId ? categoryNameMap.get(resolvedCategoryId) || null : null,
                projectTypeNames,
            };
        });

        const buildOptions = (
            rows: any[],
            keyField: 'gameTypeId' | 'categoryId',
            labelField: 'gameTypeName' | 'categoryName',
        ) =>
            Array.from(
                new Map(
                    rows
                        .map((x) => {
                            const key = String(x?.[keyField] || '').trim();
                            const label = String(x?.[labelField] || '').trim();
                            return key && label ? [key, { key, label }] : null;
                        })
                        .filter(Boolean) as Array<[string, { key: string; label: string }]>,
                ).values(),
            );

        return {
            list: mappedList,
            total: hasPaging ? total : mappedList.length,
            page,
            limit,
            totalPages: hasPaging && limit ? Math.ceil(total / limit) : 1,
            hasMore: hasPaging ? page * limit < total : false,
            filters: {
                gameTypes: pickTags(filterItems, 'gameTypeName'),
                projectTypes: pickProjectTypes(filterItems),
                categories: pickTags(filterItems, 'categoryName'),
                gameTypeOptions: buildOptions(filterItems, 'gameTypeId', 'gameTypeName'),
                categoryOptions: buildOptions(filterItems, 'categoryId', 'categoryName'),
            },
        };
    }

    async publicMenuDetail(id: number) {
        const [row, categoryTree, tagList] = await Promise.all([
            this.prisma.gameProject.findFirst({
                where: { id, status: 'ACTIVE' },
                select: {
                    id: true,
                    name: true,
                    price: true,
                    originPrice: true,
                    type: true,
                    billingMode: true,
                    baseAmount: true,
                    clubRate: true,
                    coverImage: true,
                    description: true,
                    gameType: true,
                    projectType: true,
                    category: true,
                    richContent: true,
                    createdAt: true,
                    updatedAt: true,
                },
            }),
            this.systemConfigService.getGoodsCategoryTree(),
            this.systemConfigService.getGoodsTagList(),
        ]);
        if (!row) return null;
        const categoryNameMap = this.buildCategoryNameMap(Array.isArray(categoryTree) ? categoryTree : []);
        const tagNameMap = this.buildTagNameMap(Array.isArray(tagList) ? tagList : []);
        const gameTypeId = String((row as any)?.gameType || '').trim();
        const categoryId = String((row as any)?.category || '').trim();
        const resolvedCategoryId = categoryId || null;
        const projectTypeIds = String((row as any)?.projectType || '')
            .split(',')
            .map((x) => x.trim())
            .filter((x) => !!x);
        const projectTypeNames = projectTypeIds.map((id) => tagNameMap.get(id) || id);
        return {
            ...row,
            gameTypeId: gameTypeId || null,
            categoryId: resolvedCategoryId || null,
            category: categoryId || null,
            gameTypeName: gameTypeId ? categoryNameMap.get(gameTypeId) || null : null,
            categoryName: resolvedCategoryId ? categoryNameMap.get(resolvedCategoryId) || null : null,
            projectTypeNames,
        };
    }

    async ratingSummary(projectId: number) {
        const rows = await this.prisma.productReview.findMany({
            where: { projectId: Number(projectId), isHidden: false },
            select: { score: true },
        });
        const count = rows.length;
        const avg = count ? Number((rows.reduce((s, r) => s + Number(r.score || 0), 0) / count).toFixed(2)) : 5.0;
        return { projectId: Number(projectId), ratingAvg: avg, ratingCount: count };
    }

    async listReviews(params: { projectId: number; page?: number; limit?: number; includeHidden?: boolean }) {
        const page = Math.max(1, Number(params?.page || 1));
        const limit = Math.min(100, Math.max(1, Number(params?.limit || 20)));
        const skip = (page - 1) * limit;
        const includeHidden = Boolean(params?.includeHidden);
        const where: any = { projectId: Number(params.projectId) };
        if (!includeHidden) where.isHidden = false;
        const [data, total] = await Promise.all([
            this.prisma.productReview.findMany({
                where,
                skip,
                take: limit,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                select: {
                    id: true,
                    score: true,
                    tags: true,
                    content: true,
                    anonymous: true,
                    isHidden: true,
                    hiddenReason: true,
                    hiddenAt: true,
                    createdAt: true,
                    orderId: true,
                    user: { select: { id: true, name: true, phone: true } },
                },
            }),
            this.prisma.productReview.count({ where }),
        ]);
        return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
    }

    async hideReview(reviewId: number, params: { hidden: boolean; reason?: string; operatorId?: number }) {
        const hidden = Boolean(params.hidden);
        return this.prisma.productReview.update({
            where: { id: Number(reviewId) },
            data: hidden
                ? {
                    isHidden: true,
                    hiddenReason: params.reason ? String(params.reason).slice(0, 255) : null,
                    hiddenBy: params.operatorId ? Number(params.operatorId) : null,
                    hiddenAt: new Date(),
                }
                : {
                    isHidden: false,
                    hiddenReason: null,
                    hiddenBy: null,
                    hiddenAt: null,
                },
        });
    }
}
