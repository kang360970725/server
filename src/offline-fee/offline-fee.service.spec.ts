import { StaffEmploymentStatus, UserType } from '@prisma/client';
import { OfflineFeeService } from './offline-fee.service';

describe('OfflineFeeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('excludes exited and blacklisted staff when generating offline fee bills', async () => {
    const tx: any = {
      offlineFeeContract: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      userLog: {
        create: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const service = new OfflineFeeService(prisma);

    await service.generateBillsForMonth('2026-07');

    expect(tx.offlineFeeContract.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          user: {
            userType: UserType.STAFF,
            staffEmploymentStatus: {
              in: [StaffEmploymentStatus.ACTIVE, StaffEmploymentStatus.FROZEN],
            },
          },
        }),
      }),
    );
  });

  it('prorates the first month by inclusive active days and uses the 20th as billing date', async () => {
    const tx: any = {
      offlineFeeContract: { findMany: jest.fn().mockResolvedValue([{
        id: 1,
        userId: 7,
        monthlyAmount: 310,
        startDate: new Date('2026-07-20T00:00:00.000Z'),
        endDate: null,
        status: 'ACTIVE',
        remark: null,
      }]) },
      offlineFeeBill: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => ({ id: 9, ...data })),
      },
    };
    const service = new OfflineFeeService({ $transaction: (fn: any) => fn(tx) } as any);

    await service.generateBillsForMonth('2026-07');

    expect(tx.offlineFeeBill.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        billMonth: '2026-07',
        shouldPayAmount: 120,
        remainingAmount: 120,
        periodStart: new Date('2026-07-20T00:00:00.000Z'),
        periodEnd: new Date('2026-07-31T00:00:00.000Z'),
        dueAt: new Date('2026-07-20T00:00:00.000Z'),
      }),
    });
  });

  it('does not overwrite an existing bill during recurring automatic generation', async () => {
    const tx: any = {
      offlineFeeContract: { findMany: jest.fn().mockResolvedValue([{
        id: 1,
        userId: 7,
        monthlyAmount: 300,
        startDate: new Date('2026-07-01T00:00:00.000Z'),
        endDate: null,
        status: 'ACTIVE',
      }]) },
      offlineFeeBill: {
        findUnique: jest.fn().mockResolvedValue({ id: 9, paidAmount: 0, status: 'UNPAID' }),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    const service = new OfflineFeeService({ $transaction: (fn: any) => fn(tx) } as any);

    await service.generateBillsForMonth('2026-07');

    expect(tx.offlineFeeBill.create).not.toHaveBeenCalled();
    expect(tx.offlineFeeBill.update).not.toHaveBeenCalled();
  });

  it('repairs a paid bill generated in August but incorrectly attributed to September', async () => {
    const paidBill = {
      id: 21,
      userId: 7,
      billMonth: '2026-09',
      periodStart: new Date('2026-09-01T00:00:00.000Z'),
      periodEnd: new Date('2026-09-30T00:00:00.000Z'),
      dueAt: new Date('2026-09-20T00:00:00.000Z'),
      shouldPayAmount: 300,
      paidAmount: 300,
      status: 'PAID',
      createdBy: null,
      generatedAt: new Date('2026-08-20T00:05:00.000Z'),
      createdAt: new Date('2026-08-20T00:05:00.000Z'),
      user: { id: 7, name: '测试服务者' },
    };
    const update = jest.fn().mockImplementation(({ data }) => ({ ...paidBill, ...data }));
    const prisma: any = {
      offlineFeeBill: {
        findMany: jest.fn()
          .mockResolvedValueOnce([paidBill])
          .mockResolvedValueOnce([{ id: 21, userId: 7, billMonth: '2026-09' }]),
      },
      offlineFeeContract: {
        findMany: jest.fn().mockResolvedValue([{
          id: 1,
          userId: 7,
          monthlyAmount: 300,
          startDate: new Date('2026-08-01T00:00:00.000Z'),
          endDate: null,
          status: 'ACTIVE',
        }]),
      },
      userLog: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((callback) => callback({
        offlineFeeBill: {
          findUnique: jest.fn().mockResolvedValue(paidBill),
          update,
        },
      })),
    };
    const service = new OfflineFeeService(prisma);

    const result = await service.repairExistingBills(true);

    expect(result).toMatchObject({ applied: 1, blocked: 0 });
    expect(result.candidates[0]).toMatchObject({
      oldBillMonth: '2026-09',
      billMonth: '2026-08',
      oldAmount: 300,
      amount: 300,
      paidAmount: 300,
      blockedReason: null,
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 21 },
      data: expect.objectContaining({
        billMonth: '2026-08',
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        periodEnd: new Date('2026-08-31T00:00:00.000Z'),
        dueAt: new Date('2026-08-20T00:00:00.000Z'),
        status: 'PAID',
        remainingAmount: 0,
      }),
    }));
  });

  it('rejects an offline fee period whose end date is before its start date', async () => {
    const service = new OfflineFeeService({} as any);
    await expect(service.manualCreateBill({
      userId: 7,
      month: '2026-09',
      amount: 100,
      periodStart: '2026-09-20',
      periodEnd: '2026-09-01',
      dueAt: '2026-09-20',
    })).rejects.toThrow('费用周期结束日期不能早于开始日期');
  });

  it('does not create or return withdrawal guard bills for exited staff', async () => {
    const tx: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          userType: UserType.STAFF,
          workMode: 'ONLINE',
          staffEmploymentStatus: StaffEmploymentStatus.EXITED,
        }),
      },
      walletAccount: {
        findUnique: jest.fn().mockResolvedValue({
          availableBalance: 300,
          frozenBalance: 0,
        }),
      },
      offlineFeeBill: {
        findFirst: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const service = new OfflineFeeService(prisma);

    const result = await service.getWithdrawalGuardInfo(7);

    expect(tx.offlineFeeBill.findFirst).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      hasOutstanding: false,
      bill: null,
      availableBalance: 300,
      frozenBalance: 0,
      walletTotal: 300,
    });
  });

  it('does not auto generate missing bills during withdrawal guard checks', async () => {
    const tx: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          userType: UserType.STAFF,
          staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
        }),
        findMany: jest.fn(),
      },
      walletAccount: {
        findUnique: jest.fn().mockResolvedValue({
          availableBalance: 300,
          frozenBalance: 0,
        }),
      },
      offlineFeeBill: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const service = new OfflineFeeService(prisma);

    const result = await service.getWithdrawalGuardInfo(8);

    expect(tx.user.findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      hasOutstanding: false,
      bill: null,
      availableBalance: 300,
      frozenBalance: 0,
      walletTotal: 300,
    });
  });

  it('rejects deleting offline fee bills before they are waived', async () => {
    const tx: any = {
      offlineFeeBill: {
        findUnique: jest.fn().mockResolvedValue({
          id: 11,
          status: 'UNPAID',
          payments: [],
        }),
        delete: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const service = new OfflineFeeService(prisma);

    await expect(service.deleteWaivedBill({ billId: 11 })).rejects.toThrow('仅已废除的线下费用账单可以删除');
    expect(tx.offlineFeeBill.delete).not.toHaveBeenCalled();
  });

  it('deletes waived offline fee bills without payment records', async () => {
    const tx: any = {
      offlineFeeBill: {
        findUnique: jest.fn().mockResolvedValue({
          id: 12,
          status: 'WAIVED',
          payments: [],
        }),
        delete: jest.fn().mockResolvedValue({ id: 12 }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const service = new OfflineFeeService(prisma);

    await expect(service.deleteWaivedBill({ billId: 12 })).resolves.toEqual({ success: true, billId: 12 });
    expect(tx.offlineFeeBill.delete).toHaveBeenCalledWith({ where: { id: 12 } });
  });
});
