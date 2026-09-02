import { getActivityPenaltyAmount, isActivityAssessmentPaused, shouldAutoExitForActivity, shouldRefreshActivityAfterSettlement } from './staff-activity.service';

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
});
