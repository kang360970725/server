import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ListUserLogsDto } from './dto/list-user-logs.dto';

@Injectable()
export class UserLogsService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * ✅ 统一写日志入口（非常关键）
     * 我强制所有业务模块都走这里写 UserLog，避免各模块字段不一致、漏字段、格式漂移。
     * 锚点要求“关键动作必须记录 UserLog”，我用这个入口把它工程化。
     */
    async writeLog(params: {
        userId: number;
        action: string;
        targetType: string;
        targetId?: number | null;
        oldData?: any;
        newData?: any;
        remark?: string | null;
        ip?: string | null;
        userAgent?: string | null;
    }) {
        if (!params?.userId) throw new BadRequestException('writeLog.userId 必填');
        if (!params?.action) throw new BadRequestException('writeLog.action 必填');
        if (!params?.targetType) throw new BadRequestException('writeLog.targetType 必填');

        return this.prisma.userLog.create({
            data: {
                userId: params.userId,
                action: params.action,
                targetType: params.targetType,
                targetId: params.targetId ?? null,
                oldData: params.oldData ?? undefined,
                newData: params.newData ?? undefined,
                remark: params.remark ?? null,
                ip: params.ip ?? null,
                userAgent: params.userAgent ?? null,
            },
        });
    }

    /**
     * ✅ 日志列表查询（只读）
     * - 只返回列表必要字段（不带 oldData/newData），避免列表过大
     * - 支持：userId / targetType+targetId（订单维度）/ action / 时间范围 / keyword
     */
    async list(dto: ListUserLogsDto) {
        const page = Math.max(1, Number(dto.page || 1));
        const pageSize = Math.min(100, Math.max(1, Number(dto.pageSize || 20)));
        const skip = (page - 1) * pageSize;

        const where: any = {};

        if (dto.userId) where.userId = Number(dto.userId);
        if (dto.action) where.action = dto.action;
        if (dto.targetType) where.targetType = dto.targetType;
        if (dto.targetId !== undefined && dto.targetId !== null) where.targetId = Number(dto.targetId);

        // ✅ 时间范围（日志系统必备）
        if (dto.createdAtFrom || dto.createdAtTo) {
            where.createdAt = {};
            if (dto.createdAtFrom) where.createdAt.gte = new Date(dto.createdAtFrom);
            if (dto.createdAtTo) where.createdAt.lte = new Date(dto.createdAtTo);
        }

        // ✅ keyword 只打在 action/remark 上，避免对 JSON 做 contains 导致慢查询
        if (dto.keyword) {
            where.OR = [
                { action: { contains: dto.keyword } },
                { remark: { contains: dto.keyword } },
            ];
        }

        const withUser = Boolean(dto.withUser);

        const [total, list] = await this.prisma.$transaction([
            this.prisma.userLog.count({ where }),
            this.prisma.userLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: pageSize,
                select: {
                    id: true,
                    userId: true,
                    action: true,
                    targetType: true,
                    targetId: true,
                    remark: true,
                    ip: true,
                    userAgent: true,
                    createdAt: true,
                    user: withUser
                        ? { select: { id: true, name: true, phone: true, userType: true } }
                        : false,
                },
            }),
        ]);

        return { page, pageSize, total, list };
    }

    /**
     * ✅ 单条日志详情（只读）
     * - 这里返回 oldData/newData，方便审计回溯
     */
    async detail(id: number) {
        if (!id) throw new BadRequestException('id 必填');

        const log = await this.prisma.userLog.findUnique({
            where: { id },
            include: { user: { select: { id: true, name: true, phone: true, userType: true } } },
        });

        if (!log) throw new BadRequestException('日志不存在');
        return log;
    }
}
