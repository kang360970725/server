import { OrdersService } from './orders.service';

it('lists tournament registrations with member, order and booking metadata', async () => {
    const bookedAt = new Date('2026-11-26T02:00:00.000Z');
    const entry = {
        id: 21, orderId: 12, memberId: 15001521, attemptNumber: 2, isRevival: true,
        revivalGrantedAt: new Date(), revivalRevokedAt: null, dayId: 8, status: 'BOOKED',
        createdAt: new Date('2026-11-25T01:00:00.000Z'), bookedAt, rescheduledAt: null,
        competitionName: '参赛名', gameNickname: '游戏名', contactName: '联系人',
        day: {startsAt: new Date('2026-11-27T10:00:00.000Z'), endsAt: new Date('2026-11-27T12:00:00.000Z')},
    };
    const prisma = {
        $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
        liveTournamentEntry: {
            count: jest.fn().mockResolvedValue(1),
            findMany: jest.fn().mockResolvedValue([entry]),
        },
        user: {findMany: jest.fn().mockResolvedValue([{
            id: 15001521, name: '系统昵称', avatar: 'user-avatar', memberProfile: {memberCode: 'M15001521'},
        }])},
        userWechatBinding: {findMany: jest.fn().mockResolvedValue([{
            userId: 15001521, nickname: '微信昵称', avatarUrl: 'wechat-avatar',
        }])},
        order: {findMany: jest.fn().mockResolvedValue([{
            id: 12, autoSerial: 'V202611260001', orderTime: new Date('2026-11-25T00:30:00.000Z'), currentDispatch: null,
        }])},
    };
    const service = Object.create(OrdersService.prototype) as any;
    service.prisma = prisma;

    const result = await service.listLiveTournamentRegistrations(1, {page: 1, pageSize: 20});

    expect(result).toMatchObject({total: 1, page: 1, pageSize: 20});
    expect(result.list[0]).toMatchObject({
        id: 21, revivalNumber: 1, memberCode: 'M15001521', memberNickname: '微信昵称', memberAvatar: 'wechat-avatar',
        orderNo: 'V202611260001', booked: true, bookedAt,
    });
});
