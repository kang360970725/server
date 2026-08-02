import { StaffEmploymentStatus, UserType } from '@prisma/client';
import { OfflineFeeService } from './offline-fee.service';

describe('OfflineFeeService', () => {
  const systemConfigService = {
    ensureDefaults: jest.fn().mockResolvedValue(undefined),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('excludes exited and blacklisted staff when generating offline fee bills', async () => {
    const tx: any = {
      systemConfig: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const service = new OfflineFeeService(prisma, systemConfigService);

    await service.generateBillsForMonth('2026-07');

    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userType: UserType.STAFF,
          workMode: 'OFFLINE',
          staffEmploymentStatus: {
            in: [StaffEmploymentStatus.ACTIVE, StaffEmploymentStatus.FROZEN],
          },
        }),
      }),
    );
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
        findUnique: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const service = new OfflineFeeService(prisma, systemConfigService);

    const result = await service.getWithdrawalGuardInfo(7);

    expect(tx.offlineFeeBill.findUnique).not.toHaveBeenCalled();
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
          workMode: 'OFFLINE',
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
        findUnique: jest.fn().mockResolvedValue(null),
      },
      systemConfig: {
        findMany: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const service = new OfflineFeeService(prisma, systemConfigService);

    const result = await service.getWithdrawalGuardInfo(8);

    expect(tx.user.findMany).not.toHaveBeenCalled();
    expect(tx.systemConfig.findMany).not.toHaveBeenCalled();
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
    const service = new OfflineFeeService(prisma, systemConfigService);

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
    const service = new OfflineFeeService(prisma, systemConfigService);

    await expect(service.deleteWaivedBill({ billId: 12 })).resolves.toEqual({ success: true, billId: 12 });
    expect(tx.offlineFeeBill.delete).toHaveBeenCalledWith({ where: { id: 12 } });
  });
});
