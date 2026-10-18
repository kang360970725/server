import {buildStaffResponseStats, formatEstimatedWaitTime, formatResponseTime} from './staff-response-time.util';

describe('staff response time statistics', () => {
  it('averages valid assignment-to-acceptance durations by staff', async () => {
    const prisma = {
      orderParticipant: {
        findMany: jest.fn().mockResolvedValue([
          {userId: 7, acceptedAt: new Date('2026-10-18T10:01:00Z'), dispatch: {assignedAt: new Date('2026-10-18T10:00:00Z')}},
          {userId: 7, acceptedAt: new Date('2026-10-18T10:03:00Z'), dispatch: {assignedAt: new Date('2026-10-18T10:00:00Z')}},
          {userId: 8, acceptedAt: new Date('2026-10-18T09:59:00Z'), dispatch: {assignedAt: new Date('2026-10-18T10:00:00Z')}},
        ]),
      },
    };

    const stats = await buildStaffResponseStats(prisma, [7, 8, 9]);
    expect(stats.get(7)).toEqual({averageResponseSeconds: 120, responseSampleCount: 2, averageResponseTimeText: '2分钟'});
    expect(stats.get(8)).toEqual({averageResponseSeconds: null, responseSampleCount: 0, averageResponseTimeText: '暂无数据'});
    expect(stats.get(9)).toEqual({averageResponseSeconds: null, responseSampleCount: 0, averageResponseTimeText: '暂无数据'});
  });

  it('formats card response and receipt wait labels', () => {
    expect(formatResponseTime(95)).toBe('1分35秒');
    expect(formatEstimatedWaitTime(95)).toBe('约2分钟');
    expect(formatEstimatedWaitTime(null)).toBe('5-10分钟');
  });
});
