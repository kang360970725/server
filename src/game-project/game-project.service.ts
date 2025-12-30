import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateGameProjectDto, UpdateGameProjectDto } from './dto/game-project.dto';
import { OrderType, ProjectStatus, BillingMode } from '@prisma/client';

@Injectable()
export class GameProjectService {
    constructor(private prisma: PrismaService) {}

    async create(createGameProjectDto: CreateGameProjectDto) {
        const data: any = {
            ...createGameProjectDto,
            type: createGameProjectDto.type as OrderType,
        };

        // ✅ 新增：billingMode 枚举转换（如果前端没传，走 schema 默认值）
        if (createGameProjectDto.billingMode) {
            data.billingMode = createGameProjectDto.billingMode as BillingMode;
        }

        return this.prisma.gameProject.create({ data });
    }

    async findAll() {
        return this.prisma.gameProject.findMany({
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
        });
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

    async options(params: { keyword?: string }) {
        const where: any = { status: 'ACTIVE' };
        if (params?.keyword) {
            where.OR = [{ name: { contains: params.keyword } }];
        }
        return this.prisma.gameProject.findMany({
            where,
            select: { id: true, name: true, type: true, price: true, baseAmount: true, billingMode: true },
            orderBy: { id: 'desc' },
            take: 50,
        });
    }
}
