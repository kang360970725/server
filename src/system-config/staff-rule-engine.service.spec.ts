import { StaffRuleEngineService } from './staff-rule-engine.service';

describe('StaffRuleEngineService', () => {
  it('defaults first withdrawal accepted-days threshold to 15 for existing rules', () => {
    const service = new StaffRuleEngineService({} as any);

    const config = service.normalizeConfig({
      tags: [
        {
          code: 'new_staff',
          name: '新员工',
          enabled: true,
        },
      ],
      rules: [
        {
          id: 'new_staff_rule',
          name: '新员工规则',
          enabled: true,
          tagCodes: ['new_staff'],
          depositAmount: 500,
          firstWithdrawMinBalance: 1000,
          quitCoolingDays: 180,
          depositForfeitDays: 30,
        },
      ],
    });

    expect(config.rules[0].firstWithdrawMinAcceptedDays).toBe(15);
    expect(config.rules[0].dormantFreezeDays).toBe(7);
    expect(config.rules[0].settlementFreezeExperienceDays).toBe(3);
    expect(config.rules[0].settlementFreezeRegularDays).toBe(7);
    expect(config.defaultRule.dormantFreezeDays).toBe(7);
    expect(config.defaultRule.settlementFreezeExperienceDays).toBe(3);
    expect(config.defaultRule.settlementFreezeRegularDays).toBe(7);
  });

  it('uses default rule when staff has no matching tag', () => {
    const service = new StaffRuleEngineService({} as any);

    const config = service.normalizeConfig({
      defaultRule: {
        depositAmount: 600,
        firstWithdrawMinBalance: 1200,
        firstWithdrawMinAcceptedDays: 10,
        quitCoolingDays: 90,
        depositForfeitDays: 45,
        dormantFreezeDays: 12,
        settlementFreezeExperienceDays: 4,
        settlementFreezeRegularDays: 8,
      },
      tags: [{ code: 'vip', name: 'VIP' }],
      rules: [
        {
          id: 'vip_rule',
          name: 'VIP规则',
          tagCodes: ['vip'],
          depositAmount: 800,
          firstWithdrawMinBalance: 1600,
          firstWithdrawMinAcceptedDays: 20,
          quitCoolingDays: 180,
          depositForfeitDays: 60,
          dormantFreezeDays: 5,
          settlementFreezeExperienceDays: 2,
          settlementFreezeRegularDays: 6,
        },
      ],
    });

    const matched = service.resolveMatchedRule(config, []);
    expect(matched?.id).toBe('default_rule');
    expect(matched?.depositAmount).toBe(600);
    expect(service.getDormantFreezeDays(config, [])).toBe(12);
    expect(matched?.settlementFreezeExperienceDays).toBe(4);
    expect(matched?.settlementFreezeRegularDays).toBe(8);
  });

  it('requires new saved rules to bind exactly one tag', () => {
    const service = new StaffRuleEngineService({} as any);

    expect(() =>
      service.normalizeConfig({
        tags: [
          { code: 'a', name: 'A' },
          { code: 'b', name: 'B' },
        ],
        rules: [
          {
            id: 'multi',
            name: '多标签规则',
            tagCodes: ['a', 'b'],
            depositAmount: 500,
            firstWithdrawMinBalance: 1000,
            quitCoolingDays: 180,
            depositForfeitDays: 30,
          },
        ],
      }),
    ).toThrow('必须且只能关联一个标签');
  });

  it('can normalize legacy multi-tag rules for read compatibility', () => {
    const service = new StaffRuleEngineService({} as any);

    const config = service.normalizeConfig(
      {
        tags: [
          { code: 'a', name: 'A' },
          { code: 'b', name: 'B' },
        ],
        rules: [
          {
            id: 'multi',
            name: '旧多标签规则',
            tagCodes: ['a', 'b'],
            depositAmount: 500,
            firstWithdrawMinBalance: 1000,
            quitCoolingDays: 180,
            depositForfeitDays: 30,
          },
        ],
      },
      { allowLegacyMultipleTags: true },
    );

    expect(config.rules[0].tagCodes).toEqual(['a', 'b']);
    expect(service.resolveMatchedRule(config, ['b'])?.id).toBe('multi');
  });
});
