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
});
