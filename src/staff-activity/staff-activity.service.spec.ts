import { StaffEmploymentStatus, UserStatus } from '@prisma/client';
import {
  getActivityPenaltyAmount,
  getInitialActivityNextChargeAt,
  isActivityAssessmentAccountStatus,
  isActivityAssessmentEmploymentStatus,
  isActivityAssessmentPaused,
  shouldAutoExitForActivity,
  shouldRefreshActivityAfterSettlement,
  StaffActivityService,
} from './staff-activity.service';

describe('staff activity policy', () => {
  it.each([[72, 5], [167, 5], [168, 10], [335, 10], [336, 20], [1000, 20]])(
    'uses the correct fee at %s inactive hours',
    (hours, expected) => expect(getActivityPenaltyAmount(hours)).toBe(expected),
  );

  it('exits when available balance and deposit are exhausted by the charge', () => {
    expect(shouldAutoExitForActivity(3, 2, 5)).toBe(true);
    expect(shouldAutoExitForActivity(3, 3, 5)).toBe(false);
    expect(shouldAutoExitForActivity(0, 0, 5)).toBe(true);
  });

  it('previews an overdue leave rejection without granting a new grace period', async () => {
    const startedAt = new Date('2026-09-01T00:00:00.000Z');
    const nextChargeAt = new Date('2026-09-04T00:00:00.000Z');
    const now = new Date('2026-09-09T00:00:00.000Z');
    const prisma = {
      staffLeave: {
        findUnique: jest.fn().mockResolvedValue({
          id: 12,
          userId: 7,
          status: 'ACTIVE',
          user: {
            id: 7,
            createdAt: startedAt,
            status: UserStatus.ACTIVE,
            staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
            activityAssessmentEnabled: true,
            activityTimerPaused: false,
            activityAssessmentStartedAt: startedAt,
            activityLastCompletedAt: null,
            activityNextChargeAt: nextChargeAt,
          },
        }),
      },
      walletAccount: {
        findUnique: jest.fn().mockResolvedValue({ availableBalance: 3, depositBalance: 20 }),
      },
    };
    const service = new StaffActivityService(prisma as any);

    const result = await service.getRejectLeavePreview(12, now);

    expect(result.estimate).toMatchObject({
      inactivityHours: 192,
      nextChargeAt,
      willChargeImmediately: true,
      estimatedPenaltyAmount: 5,
      estimatedAvailableDeducted: 3,
      estimatedDepositDeducted: 2,
    });
  });

  it('rejects leave transactionally, preserves the original schedule and sends both notifications', async () => {
    const now = new Date('2026-09-09T00:00:00.000Z');
    const nextChargeAt = new Date('2026-09-04T00:00:00.000Z');
    const leave = {
      id: 12,
      userId: 7,
      status: 'ACTIVE',
      user: {
        id: 7,
        name: '服务者A',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        status: UserStatus.ACTIVE,
        staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
        activityAssessmentEnabled: true,
        activityTimerPaused: false,
        activityAssessmentStartedAt: new Date('2026-09-01T00:00:00.000Z'),
        activityLastCompletedAt: null,
        activityNextChargeAt: nextChargeAt,
      },
    };
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      staffLeave: {
        findUnique: jest.fn().mockResolvedValue(leave),
        update: jest.fn().mockResolvedValue({ ...leave, status: 'REJECTED', rejectReason: '报备不符合要求' }),
      },
      walletAccount: { findUnique: jest.fn().mockResolvedValue({ availableBalance: 100, depositBalance: 500 }) },
      user: { update: jest.fn() },
      userLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
      userNotification: { create: jest.fn().mockResolvedValue({ id: 2 }) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<any>) => callback(tx)),
    };
    const notifications = {
      pushRealtimeToUsers: jest.fn().mockResolvedValue({ pushed: 1 }),
    };
    const service = new StaffActivityService(prisma as any, notifications as any);

    const result = await service.rejectLeave({ leaveId: 12, reviewerId: 99, reason: '报备不符合要求' }, now);

    expect(result.estimate.nextChargeAt).toEqual(nextChargeAt);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.staffLeave.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 12 },
      data: expect.objectContaining({ status: 'REJECTED', rejectedBy: 99, rejectReason: '报备不符合要求' }),
    }));
    expect(tx.userLog.create).toHaveBeenCalled();
    expect(tx.userNotification.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 7, title: '请假申请已被驳回' }),
    }));
    expect(notifications.pushRealtimeToUsers).toHaveBeenCalledWith(expect.objectContaining({ userIds: [7], type: 'STAFF_LEAVE_REJECTED' }));
  });

  it('pauses assessment immediately after the provider accepts an order', () => {
    expect(isActivityAssessmentPaused(true)).toBe(true);
    expect(isActivityAssessmentPaused(false)).toBe(false);
  });

  it('does not refresh activity after customer-service archive or completion', () => {
    expect(shouldRefreshActivityAfterSettlement(true)).toBe(false);
    expect(shouldRefreshActivityAfterSettlement(false)).toBe(true);
  });

  it('assesses both normal and historically frozen providers', () => {
    expect(isActivityAssessmentAccountStatus(UserStatus.ACTIVE)).toBe(true);
    expect(isActivityAssessmentAccountStatus(UserStatus.FROZEN)).toBe(true);
    expect(isActivityAssessmentAccountStatus(UserStatus.DISABLED)).toBe(false);
    expect(isActivityAssessmentEmploymentStatus(StaffEmploymentStatus.ACTIVE)).toBe(true);
    expect(isActivityAssessmentEmploymentStatus(StaffEmploymentStatus.FROZEN)).toBe(true);
    expect(isActivityAssessmentEmploymentStatus(StaffEmploymentStatus.EXITED)).toBe(false);
    expect(isActivityAssessmentEmploymentStatus(StaffEmploymentStatus.BLACKLISTED)).toBe(false);
  });

  it('initializes a missing schedule from existing activity history without a new grace period', () => {
    const startedAt = new Date('2026-09-01T00:00:00.000Z');
    const completedAt = new Date('2026-09-02T08:30:00.000Z');
    expect(getInitialActivityNextChargeAt(null, startedAt).toISOString()).toBe('2026-09-04T00:00:00.000Z');
    expect(getInitialActivityNextChargeAt(completedAt, startedAt).toISOString()).toBe('2026-09-05T08:30:00.000Z');
  });

  it('locks the mapped users table before evaluating a due charge', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
    };
    const service = new StaffActivityService(prisma as any);

    await (service as any).chargeOne(123, new Date('2026-09-07T00:00:00.000Z'));

    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT id FROM `users` WHERE id = ? FOR UPDATE',
      123,
    );
  });

  it('returns all-time actual activity penalties separately from today statistics', async () => {
    const prisma = {
      staffActivityCharge: {
        findMany: jest.fn().mockResolvedValue([
          { userId: 1, expectedAmount: 10, availableDeducted: 6, depositDeducted: 4, exitTriggered: false },
        ]),
        aggregate: jest.fn().mockResolvedValue({
          _count: 8,
          _sum: { availableDeducted: 42, depositDeducted: 18 },
        }),
      },
    };
    const service = new StaffActivityService(prisma as any);

    await expect(service.getTodayStats(new Date('2026-09-15T04:00:00.000Z'))).resolves.toMatchObject({
      chargeCount: 1,
      totalChargeCount: 8,
      totalPenaltyAmount: 60,
    });
  });
});
