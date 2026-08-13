import { BadRequestException, Injectable } from '@nestjs/common';
import { StaffEmploymentStatus, UserStatus, UserType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ExcellentStaffService {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeIdArray(value: any): number[] {
    const raw = Array.isArray(value) ? value : [];
    return Array.from(new Set(raw.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  }

  private staffSelect() {
    return {
      id: true,
      phone: true,
      name: true,
      realName: true,
      userType: true,
      status: true,
      staffEmploymentStatus: true,
      workMode: true,
      rating: true,
      staffRating: { select: { id: true, name: true } },
    };
  }

  private toRow(record: any) {
    const user = record?.user || record;
    return {
      id: Number(record?.id || 0) || undefined,
      userId: Number(user?.id || record?.userId || 0),
      name: user?.name || user?.realName || `#${user?.id || record?.userId}`,
      realName: user?.realName || null,
      phone: user?.phone || null,
      userType: user?.userType || null,
      accountStatus: user?.status || null,
      staffEmploymentStatus: user?.staffEmploymentStatus || null,
      workMode: user?.workMode || null,
      ratingName: user?.staffRating?.name || null,
      excellentStatus: record?.status || null,
      assignedAt: record?.assignedAt || null,
      assignedBy: record?.assignedBy || null,
      removedAt: record?.removedAt || null,
      remark: record?.remark || null,
    };
  }

  async list(params: { page?: number; limit?: number; keyword?: string; status?: string }) {
    const page = Math.max(1, Number(params?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(params?.limit || 20)));
    const keyword = String(params?.keyword || '').trim();
    const status = String(params?.status || 'ACTIVE').trim().toUpperCase();
    const where: any = {};
    if (status && status !== 'ALL') where.status = status;
    if (keyword) {
      where.OR = [
        { user: { name: { contains: keyword } } },
        { user: { realName: { contains: keyword } } },
        { user: { phone: { contains: keyword } } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.excellentStaff.findMany({
        where,
        include: { user: { select: this.staffSelect() as any } },
        orderBy: [{ status: 'asc' }, { assignedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.excellentStaff.count({ where }),
    ]);
    return { data: rows.map((row) => this.toRow(row)), total, page, limit };
  }

  async candidates(params: { keyword?: string; limit?: number }) {
    const keyword = String(params?.keyword || '').trim();
    const limit = Math.min(100, Math.max(1, Number(params?.limit || 50)));
    const where: any = {
      userType: UserType.STAFF,
      status: { not: UserStatus.DISABLED },
      staffEmploymentStatus: { in: [StaffEmploymentStatus.ACTIVE, StaffEmploymentStatus.FROZEN] },
    };
    if (keyword) {
      where.OR = [
        { name: { contains: keyword } },
        { realName: { contains: keyword } },
        { phone: { contains: keyword } },
        ...(Number.isFinite(Number(keyword)) ? [{ id: Number(keyword) }] : []),
      ];
    }
    const users = await this.prisma.user.findMany({
      where,
      select: {
        ...(this.staffSelect() as any),
        excellentStaffRecord: { select: { status: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return users.map((user: any) => ({
      ...this.toRow(user),
      isExcellent: String(user?.excellentStaffRecord?.status || '') === 'ACTIVE',
    }));
  }

  async add(userIdsInput: any, operatorId?: number, remark?: string) {
    const userIds = this.normalizeIdArray(userIdsInput);
    if (!userIds.length) throw new BadRequestException('请选择服务者');
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: userIds },
        userType: UserType.STAFF,
        staffEmploymentStatus: { in: [StaffEmploymentStatus.ACTIVE, StaffEmploymentStatus.FROZEN] },
      },
      select: { id: true },
    });
    if (users.length !== userIds.length) {
      throw new BadRequestException('只能选择未退出平台的服务者');
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const userId of userIds) {
        await tx.excellentStaff.upsert({
          where: { userId },
          update: {
            status: 'ACTIVE',
            assignedBy: operatorId || null,
            assignedAt: now,
            removedBy: null,
            removedAt: null,
            remark: remark || null,
          },
          create: {
            userId,
            status: 'ACTIVE',
            assignedBy: operatorId || null,
            assignedAt: now,
            remark: remark || null,
          },
        });
      }
    });
    return { success: true, count: userIds.length };
  }

  async remove(userIdsInput: any, operatorId?: number, remark?: string) {
    const userIds = this.normalizeIdArray(userIdsInput);
    if (!userIds.length) throw new BadRequestException('请选择服务者');
    const result = await this.prisma.excellentStaff.updateMany({
      where: { userId: { in: userIds }, status: 'ACTIVE' },
      data: {
        status: 'REMOVED',
        removedBy: operatorId || null,
        removedAt: new Date(),
        remark: remark || null,
      },
    });
    return { success: true, count: result.count };
  }
}
