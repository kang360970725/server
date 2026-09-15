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
