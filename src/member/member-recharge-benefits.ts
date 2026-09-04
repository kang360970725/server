export type RechargeCouponBenefit = { templateId: number; count: number };

export function normalizeRechargeCouponBenefits(input: any): RechargeCouponBenefit[] {
  const list = Array.isArray(input) ? input : [];
  const normalized = list
    .map((item: any) => ({
      templateId: Number(item?.templateId || 0),
      count: Math.min(999, Math.max(1, Math.floor(Number(item?.count || 1)))),
    }))
    .filter((item) => Number.isFinite(item.templateId) && item.templateId > 0)
    .slice(0, 20);

  const uniq = new Map<number, RechargeCouponBenefit>();
  for (const item of normalized) {
    const previous = uniq.get(item.templateId);
    uniq.set(item.templateId, {
      templateId: item.templateId,
      count: Math.min(999, Number(previous?.count || 0) + item.count),
    });
  }
  return Array.from(uniq.values());
}
