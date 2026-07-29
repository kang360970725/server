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
  });
});
