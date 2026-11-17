import { OrdersService } from './orders.service';

describe('OrdersService order review management', () => {
    it('returns product, player and latest dispatcher reviews together', async () => {
        const rows = [{
            id: 1,
            orderId: 9,
            score: 4.5,
            order: {
                id: 9,
                autoSerial: 'V-9',
                status: 'REVIEWED',
                playerEvaluations: [{id: 3, score: 4.5}],
            },
        }];
        const prisma = {
            productReview: {
                findMany: jest.fn().mockResolvedValue(rows),
                count: jest.fn().mockResolvedValue(1),
            },
            userLog: {findMany: jest.fn().mockResolvedValue([
                {id: 8, targetId: 9, newData: {dispatcherUserName: '客服A', score: 5}, createdAt: new Date('2026-11-17')},
                {id: 7, targetId: 9, newData: {dispatcherUserName: '旧客服', score: 3}, createdAt: new Date('2026-11-16')},
            ])},
            $transaction: jest.fn().mockResolvedValue([rows, 1]),
        };
        const service = Object.create(OrdersService.prototype) as OrdersService;
        (service as any).prisma = prisma;

        const result = await service.listOrderReviews({page: 1, limit: 20, keyword: 'V-9'});

        expect(result.total).toBe(1);
        expect(result.data[0]).toMatchObject({
            orderId: 9,
            playerEvaluations: [{id: 3, score: 4.5}],
            dispatcherReview: {dispatcherUserName: '客服A', score: 5, logId: 8},
        });
        expect(prisma.productReview.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({OR: expect.any(Array)}),
            take: 20,
        }));
    });

    it('removes member identity from anonymous review responses', async () => {
        const rows = [{
            id: 2,
            orderId: 10,
            score: 5,
            anonymous: true,
            user: {id: 20, name: '真实昵称', phone: '13800000000', avatar: 'avatar.jpg'},
            order: {id: 10, autoSerial: 'V-10', status: 'REVIEWED', playerEvaluations: []},
        }];
        const prisma = {
            productReview: {
                findMany: jest.fn().mockResolvedValue(rows),
                count: jest.fn().mockResolvedValue(1),
            },
            userLog: {findMany: jest.fn().mockResolvedValue([])},
            $transaction: jest.fn().mockResolvedValue([rows, 1]),
        };
        const service = Object.create(OrdersService.prototype) as OrdersService;
        (service as any).prisma = prisma;

        const result = await service.listOrderReviews({page: 1, limit: 20});

        expect(result.data[0].anonymous).toBe(true);
        expect(result.data[0].user).toBeNull();
        expect(result.data[0].orderId).toBeNull();
        expect(result.data[0].order).toBeNull();
    });
});
