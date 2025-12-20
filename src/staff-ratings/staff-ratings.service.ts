import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import {CreateStaffRatingDto} from './dto/create-staff-rating.dto';
import { UpdateStaffRatingDto } from './dto/update-staff-rating.dto';
import { RatingStatus } from '@prisma/client';

@Injectable()
export class StaffRatingsService {
    constructor(private prisma: PrismaService) {}

    async create(createStaffRatingDto: CreateStaffRatingDto) {
        // 设置默认值
        const data = {
            ...createStaffRatingDto,
            status: createStaffRatingDto.status || RatingStatus.ACTIVE,
            sortOrder: createStaffRatingDto.sortOrder || 0,
        };

        return this.prisma.staffRating.create({
            data,
        });
    }

    async findAll(params: {
        page: number;
        pageSize: number;
        name?: string;
        status?: string;
    }) {
        const { page, pageSize, name, status } = params;
        const skip = (page - 1) * pageSize;

        const where: any = {};
        if (name) {
            where.name = { contains: name };
        }
        if (status) {
            where.status = status;
        }

        const [data, total] = await Promise.all([
            this.prisma.staffRating.findMany({
                where,
                skip,
                take: pageSize,
                orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            }),
            this.prisma.staffRating.count({ where }),
        ]);

        return {
            data,
            total,
            page,
            pageSize,
        };
    }

    async findOne(id: number) {
        return this.prisma.staffRating.findUnique({
            where: { id },
        });
    }

    async update(id: number, updateStaffRatingDto: UpdateStaffRatingDto) {
        return this.prisma.staffRating.update({
            where: { id },
            data: updateStaffRatingDto,
        });
    }

    async remove(id: number) {
        return this.prisma.staffRating.delete({
            where: { id },
        });
    }
}
