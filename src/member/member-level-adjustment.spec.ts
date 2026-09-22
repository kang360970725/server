import { BadRequestException } from '@nestjs/common';
import { MemberService } from './member.service';

describe('会员等级人工调整', () => {
  function createService(totalConsumeAmount: number) {
    const tx: any = {
      memberProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 3, userId: 2, levelCode: 'V5', totalConsumeAmount }),
        update: jest.fn().mockImplementation(({ data }) => ({ id: 3, userId: 2, ...data })),
      },
      memberLevelConfig: { findUnique: jest.fn().mockResolvedValue({ id: 6, code: 'V6', enabled: true }) },
      userLog: { create: jest.fn() },
      memberLevelOperation: { create: jest.fn() },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    const benefits: any = { grantForLevelChange: jest.fn() };
    const service: any = new MemberService(prisma, {} as any, {} as any, {} as any, benefits);
    service.ensureUserAssets = jest.fn();
    return { service, tx, benefits };
  }

  it('累计有效消费不足60000时不能人工授予V6', async () => {
    const { service } = createService(59999.99);
    await expect(service.adjustMemberLevel({ userId: 2, levelCode: 'V6', remark: '人工晋升' }, 1))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('达到条件后记录等级操作并按目标等级发放独立权益', async () => {
    const { service, tx, benefits } = createService(60000);
    await service.adjustMemberLevel({ userId: 2, levelCode: 'V6', remark: '条件已核验' }, 1);
    expect(tx.memberProfile.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ levelCode: 'V6', manualLevelCode: 'V6' }),
    }));
    expect(tx.memberLevelOperation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ beforeLevelCode: 'V5', afterLevelCode: 'V6', operationType: 'ADMIN_ADJUST' }),
    }));
    expect(benefits.grantForLevelChange).toHaveBeenCalledWith(expect.objectContaining({
      beforeLevelCode: 'V5', afterLevelCode: 'V6', userId: 2,
    }));
  });
});
