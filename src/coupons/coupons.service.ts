import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CouponScope,
  CouponTemplateStatus,
  CouponTemplateType,
  Prisma,
  UserCouponStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CreateCouponTemplateDto } from './dto/create-coupon-template.dto';
import { UpdateCouponTemplateStatusDto } from './dto/update-coupon-template-status.dto';
import { GrantUserCouponDto } from './dto/grant-user-coupon.dto';

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  private toAmount2(value: number) {
    return Number(Number(value || 0).toFixed(2));
  }

  async listTemplates(body: any) {
    const page = Math.max(1, Number(body?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(body?.limit || 20)));
    const skip = (page - 1) * limit;
    const where: Prisma.CouponTemplateWhereInput = {};

    if (body?.status) where.status = body.status;
    if (body?.type) where.type = body.type;
    if (body?.keyword) where.name = { contains: String(body.keyword).trim() };

    const [data, total] = await Promise.all([
      this.prisma.couponTemplate.findMany({
        where,
        orderBy: { id: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.couponTemplate.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async createTemplate(dto: CreateCouponTemplateDto, operatorId?: number) {
    if (!dto.name?.trim()) throw new BadRequestException('券名称不能为空');
    const type = dto.type;
    if (!Object.values(CouponTemplateType).includes(type)) {
      throw new BadRequestException('券类型不合法');
    }
    const applicableScope = dto.applicableScope || CouponScope.ALL;
    const scopeTargetIds = Array.isArray(dto.applicableProjectIds) ? dto.applicableProjectIds : [];
    const projectTargetIds = scopeTargetIds
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);
    const categoryTargetIds = scopeTargetIds
      .map((x) => String(x || '').trim())
      .filter((x) => !!x);

    if (applicableScope === CouponScope.PROJECT && !projectTargetIds.length) {
      throw new BadRequestException('指定商品券必须配置可用商品');
    }
    if (applicableScope === CouponScope.CATEGORY && !categoryTargetIds.length) {
      throw new BadRequestException('指定分类券必须配置可用分类');
    }
    if (applicableScope === CouponScope.USER_LEVEL) {
      throw new BadRequestException('指定等级功能尚未开放');
    }
    const discountValue = dto.discountValue == null ? null : this.toAmount2(Number(dto.discountValue));
    const thresholdAmount = dto.thresholdAmount == null ? null : this.toAmount2(Number(dto.thresholdAmount));
    const maxDiscountAmount = dto.maxDiscountAmount == null ? null : this.toAmount2(Number(dto.maxDiscountAmount));

    if (
      (type === CouponTemplateType.CASH
        || type === CouponTemplateType.FULL_REDUCTION
        || type === CouponTemplateType.DISCOUNT)
      && !discountValue
    ) {
      throw new BadRequestException('当前券类型必须配置优惠值');
    }
    if (type === CouponTemplateType.FULL_REDUCTION && (thresholdAmount == null || thresholdAmount <= 0)) {
      throw new BadRequestException('满减券必须配置门槛金额');
    }

    const startAt = dto.startAt ? new Date(dto.startAt) : null;
    const endAt = dto.endAt ? new Date(dto.endAt) : null;
    if (startAt && endAt && endAt <= startAt) {
      throw new BadRequestException('结束时间必须晚于开始时间');
    }

    return this.prisma.couponTemplate.create({
      data: {
        name: dto.name.trim(),
        type,
        discountValue,
        thresholdAmount,
        maxDiscountAmount,
        applicableScope,
        applicableProjectIds:
          applicableScope === CouponScope.PROJECT
            ? (projectTargetIds as any)
            : applicableScope === CouponScope.CATEGORY
              ? (categoryTargetIds as any)
            : null,
        status: dto.status || CouponTemplateStatus.DRAFT,
        startAt,
        endAt,
        totalLimit: dto.totalLimit ?? null,
        perUserLimit: dto.perUserLimit ?? null,
      },
    });
  }

  async updateTemplateStatus(dto: UpdateCouponTemplateStatusDto) {
    const row = await this.prisma.couponTemplate.findUnique({ where: { id: Number(dto.id) } });
    if (!row) throw new NotFoundException('券模板不存在');
    return this.prisma.couponTemplate.update({
      where: { id: Number(dto.id) },
      data: { status: dto.status },
    });
  }

  async grantUserCoupon(dto: GrantUserCouponDto, operatorId?: number) {
    const userId = Number(dto.userId);
    const templateId = Number(dto.templateId);
    const count = Math.max(1, Number(dto.count || 1));
    if (count > 200) throw new BadRequestException('单次发券数量不能超过200');

    const [user, template] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
      this.prisma.couponTemplate.findUnique({ where: { id: templateId } }),
    ]);
    if (!user) throw new NotFoundException('用户不存在');
    if (!template) throw new NotFoundException('券模板不存在');
    if (template.status !== CouponTemplateStatus.ACTIVE) {
      throw new BadRequestException('券模板未生效，不能发券');
    }
    const now = new Date();
    if (template.startAt && now < template.startAt) throw new BadRequestException('券模板尚未开始');
    if (template.endAt && now > template.endAt) throw new BadRequestException('券模板已过期');

    return this.prisma.$transaction(async (tx) => {
      if (template.totalLimit && template.issuedCount + count > template.totalLimit) {
        throw new BadRequestException('超出券模板总发放上限');
      }
      if (template.perUserLimit && template.perUserLimit > 0) {
        const userCount = await tx.userCoupon.count({
          where: { userId, templateId },
        });
        if (userCount + count > template.perUserLimit) {
          throw new BadRequestException('超出用户领券上限');
        }
      }

      const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : template.endAt || null;
      if (expiresAt && expiresAt <= now) {
        throw new BadRequestException('券过期时间必须晚于当前时间');
      }

      const rows = Array.from({ length: count }).map(() => ({
        userId,
        templateId,
        status: UserCouponStatus.UNUSED,
        receivedAt: now,
        expiresAt,
      }));
      await tx.userCoupon.createMany({ data: rows });
      await tx.couponTemplate.update({
        where: { id: templateId },
        data: { issuedCount: { increment: count } },
      });
      return { success: true, count };
    });
  }

  async listUserCoupons(body: any) {
    const page = Math.max(1, Number(body?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(body?.limit || 20)));
    const skip = (page - 1) * limit;

    const where: Prisma.UserCouponWhereInput = {};
    if (body?.userId) where.userId = Number(body.userId);
    if (body?.templateId) where.templateId = Number(body.templateId);
    if (body?.status) where.status = body.status;
    if (body?.orderId) where.orderId = Number(body.orderId);

    const [data, total] = await Promise.all([
      this.prisma.userCoupon.findMany({
        where,
        include: {
          template: true,
          user: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { id: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.userCoupon.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}
