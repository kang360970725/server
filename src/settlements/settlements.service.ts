// src/settlements/settlements.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentStatus } from '@prisma/client';

@Injectable()
export class SettlementsService {
    constructor(private prisma: PrismaService) {}

    /**
     * 查询某个结算周期内的结算明细 + 汇总
     */
    async queryBatch(params: {
        type: 'EXPERIENCE_3DAY' | 'MONTHLY_REGULAR';
        start?: string;
        end?: string;
    }) {
        const { type } = params;
        if (!type) throw new BadRequestException('type 必填');

        let start: Date;
        let end: Date;

        if (params.start && params.end) {
            start = new Date(params.start);
            end = new Date(params.end);
        } else {
            const now = new Date();

            if (type === 'EXPERIENCE_3DAY') {
                end = now;
                start = new Date();
                start.setDate(end.getDate() - 3);
            } else {
                // 上月 1 号 ~ 上月末
                const firstDayThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                end = new Date(firstDayThisMonth.getTime() - 1);
                start = new Date(end.getFullYear(), end.getMonth(), 1);
            }
        }

        const settlements = await this.prisma.orderSettlement.findMany({
            where: {
                settledAt: {
                    gte: start,
                    lte: end,
                },
            },
            include: {
                user: {
                    select: { id: true, name: true, phone: true },
                },
                order: {
                    select: {
                        id: true,
                        autoSerial: true,
                        paidAmount: true,
                        clubEarnings: true,
                    },
                },
            },
        });

        const totalIncome = settlements.reduce((sum, s) => sum + (s.order?.paidAmount || 0), 0);
        const clubIncome = settlements.reduce((sum, s) => sum + (s.order?.clubEarnings || 0), 0);
        const payableToPlayers = settlements.reduce((sum, s) => sum + (s.finalEarnings || 0), 0);

        return {
            period: { start, end },
            totalIncome,
            clubIncome,
            payableToPlayers,
            list: settlements,
        };
    }

    /**
     * 标记结算记录为已打款
     */
    async markPaid(settlementIds: number[], operatorId?: number, remark?: string) {
        if (!Array.isArray(settlementIds) || settlementIds.length === 0) {
            throw new BadRequestException('settlementIds 不能为空');
        }

        await this.prisma.orderSettlement.updateMany({
            where: {
                id: { in: settlementIds },
                paymentStatus: PaymentStatus.UNPAID,
            },
            data: {
                paymentStatus: PaymentStatus.PAID,
                paidAt: new Date(),
                adjustedBy: operatorId,
                adjustRemark: remark,
            },
        });

        return { success: true };
    }
}
