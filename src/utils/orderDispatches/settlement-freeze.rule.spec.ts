import { computeSettlementFreezeTime } from './settlement-freeze.rule';

const buildOrder = (type: string) => ({
  projectSnapshot: { type },
  dispatches: [
    {
      status: 'COMPLETED',
      completedAt: new Date('2026-08-01T00:00:00.000Z'),
    },
  ],
});

describe('computeSettlementFreezeTime', () => {
  it('uses 3 days for experience-like orders and 7 days for regular orders by default', () => {
    const experience = computeSettlementFreezeTime({ order: buildOrder('EXPERIENCE') });
    const luckyBag = computeSettlementFreezeTime({ order: buildOrder('LUCKY_BAG') });
    const regular = computeSettlementFreezeTime({ order: buildOrder('REGULAR') });

    expect(experience.freezeDays).toBe(3);
    expect(luckyBag.freezeDays).toBe(3);
    expect(regular.freezeDays).toBe(7);
    expect(experience.freezeEndAt.toISOString()).toBe('2026-08-04T00:00:00.000Z');
    expect(regular.freezeEndAt.toISOString()).toBe('2026-08-08T00:00:00.000Z');
  });

  it('uses configured freeze days with fallback for invalid values', () => {
    const experience = computeSettlementFreezeTime({
      order: buildOrder('EXPERIENCE'),
      freezeDaysConfig: { experienceDays: 5, regularDays: 9 },
    });
    const regular = computeSettlementFreezeTime({
      order: buildOrder('REGULAR'),
      freezeDaysConfig: { experienceDays: -1, regularDays: Number.NaN },
    });

    expect(experience.freezeDays).toBe(5);
    expect(experience.freezeEndAt.toISOString()).toBe('2026-08-06T00:00:00.000Z');
    expect(regular.freezeDays).toBe(7);
  });
});
