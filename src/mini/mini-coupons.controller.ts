import { BadRequestException, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { CouponTemplateStatus, UserCouponStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { miniOk } from './mini.response';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

@ApiTags('mini-coupons')
@ApiBearerAuth()
@Controller('mini/coupons')
export class MiniCouponsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('center')
  @ApiOperation({ summary: '领券中心列表' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'type', required: false, example: 'CASH' })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: { list: [], total: 0, page: 1, limit: 20, totalPages: 0 },
      },
    },
  })
  async center(@Query() query: any) {
    const page = Math.max(1, Number(query?.page ?? 1));
    const limit = Math.min(50, Math.max(1, Number(query?.limit ?? 20)));
    const skip = (page - 1) * limit;
    const now = new Date();

    const where: any = {
      status: CouponTemplateStatus.ACTIVE,
      OR: [
        { startAt: null },
        { startAt: { lte: now } },
      ],
      AND: [
        {
          OR: [
            { endAt: null },
            { endAt: { gte: now } },
          ],
        },
      ],
    };
    if (query?.type) where.type = query.type;

    const [list, total] = await Promise.all([
      this.prisma.couponTemplate.findMany({
        where,
        orderBy: [{ id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.couponTemplate.count({ where }),
    ]);

    return miniOk({ list, total, page, limit, totalPages: Math.ceil(total / limit) });
  }

  @Get('mine')
  @ApiOperation({ summary: '我的优惠券' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'status', required: false, enum: UserCouponStatus })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: 'ok',
        data: { list: [], total: 0, page: 1, limit: 20, totalPages: 0 },
      },
    },
  })
  async mine(@Req() req: any, @Query() query: any) {
    const userId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
    const page = Math.max(1, Number(query?.page ?? 1));
    const limit = Math.min(50, Math.max(1, Number(query?.limit ?? 20)));
    const skip = (page - 1) * limit;
    const now = new Date();

    await this.prisma.userCoupon.updateMany({
      where: {
        userId,
        status: UserCouponStatus.UNUSED,
        expiresAt: { lt: now },
      },
      data: { status: UserCouponStatus.EXPIRED },
    });

    const where: any = { userId };
    if (query?.status) where.status = query.status as UserCouponStatus;

    const [list, total] = await Promise.all([
      this.prisma.userCoupon.findMany({
        where,
        include: { template: true },
        orderBy: { id: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.userCoupon.count({ where }),
    ]);

    return miniOk({ list, total, page, limit, totalPages: Math.ceil(total / limit) });
  }

  @Post('claim')
  @ApiOperation({ summary: '领取优惠券' })
  @ApiQuery({ name: 'templateId', required: true, example: 1 })
  @ApiOkResponse({
    schema: {
      example: {
        code: 0,
        message: '领取成功',
        data: { id: 123, userId: 1, templateId: 1, status: 'UNUSED' },
      },
    },
  })
  async claim(@Req() req: any, @Query('templateId') templateIdRaw: string) {
    const userId = Number(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub);
    const templateId = Number(templateIdRaw);
    if (!templateId) throw new BadRequestException('templateId 必填');

    const template = await this.prisma.couponTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw new BadRequestException('券模板不存在');
    if (template.status !== CouponTemplateStatus.ACTIVE) throw new BadRequestException('券模板未生效');
    const now = new Date();
    if (template.startAt && now < template.startAt) throw new BadRequestException('券模板尚未开始');
    if (template.endAt && now > template.endAt) throw new BadRequestException('券模板已过期');

    const claimedCount = await this.prisma.userCoupon.count({
      where: { userId, templateId },
    });
    if (template.perUserLimit && claimedCount >= template.perUserLimit) {
      throw new BadRequestException('超出每人领取上限');
    }

    if (template.totalLimit && template.issuedCount >= template.totalLimit) {
      throw new BadRequestException('已领完');
    }

    const data = await this.prisma.$transaction(async (tx) => {
      const coupon = await tx.userCoupon.create({
        data: {
          userId,
          templateId,
          status: UserCouponStatus.UNUSED,
          receivedAt: now,
          expiresAt: template.endAt || null,
        },
      });
      await tx.couponTemplate.update({
        where: { id: templateId },
        data: { issuedCount: { increment: 1 } },
      });
      return coupon;
    });

    return miniOk(data, '领取成功');
  }
}
