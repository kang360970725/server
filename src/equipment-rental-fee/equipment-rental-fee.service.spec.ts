import { EquipmentRentalFeeService } from './equipment-rental-fee.service';
import { StaffEmploymentStatus, UserType } from '@prisma/client';

describe('EquipmentRentalFeeService', () => {
  it('allows contract creation for active offline staff', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          userType: UserType.STAFF,
          workMode: 'OFFLINE',
          staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
        }),
      },
      equipmentRentalContract: {
        create: jest.fn().mockResolvedValue({ id: 1, userId: 7 }),
      },
    } as any;
    const service = new EquipmentRentalFeeService(prisma);

    await expect(
      service.createContract({ userId: 7, monthlyAmount: 100, startMonth: '2026-08' }, 1),
    ).resolves.toMatchObject({ id: 1, userId: 7 });
  });

  it('allows contract creation for frozen staff', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          userType: UserType.STAFF,
          workMode: 'ONLINE',
          staffEmploymentStatus: StaffEmploymentStatus.FROZEN,
        }),
      },
      equipmentRentalContract: {
        create: jest.fn().mockResolvedValue({ id: 2, userId: 8 }),
      },
    } as any;
    const service = new EquipmentRentalFeeService(prisma);

    await expect(
      service.createContract({ userId: 8, monthlyAmount: 100, startMonth: '2026-08' }, 1),
    ).resolves.toMatchObject({ id: 2, userId: 8 });
  });

  it('rejects contract creation for exited staff', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          userType: UserType.STAFF,
          workMode: 'ONLINE',
          staffEmploymentStatus: StaffEmploymentStatus.EXITED,
        }),
      },
      equipmentRentalContract: {
        create: jest.fn(),
      },
    } as any;
    const service = new EquipmentRentalFeeService(prisma);

    await expect(
      service.createContract({ userId: 9, monthlyAmount: 100, startMonth: '2026-08' }, 1),
    ).rejects.toThrow('仅支持为未退店、未拉黑陪玩配置设备租赁费');
    expect(prisma.equipmentRentalContract.create).not.toHaveBeenCalled();
  });

  it('generates bills by due month based on contract start date', async () => {
    const createdBills: any[] = [];
    const prisma = {
      equipmentRentalContract: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 31,
            userId: 7,
            status: 'ACTIVE',
            monthlyAmount: 100,
            startDate: new Date(Date.UTC(2026, 7, 15)),
            endDate: null,
          },
        ]),
      },
      equipmentRentalBill: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn((payload) => {
          createdBills.push(payload.data);
          return Promise.resolve({ id: 41, ...payload.data });
        }),
      },
    } as any;
    const service = new EquipmentRentalFeeService(prisma);

    await expect(service.generateBillsForMonth('2026-09')).resolves.toMatchObject({ month: '2026-09', affected: 1 });
    expect(createdBills[0]).toMatchObject({
      contractId: 31,
      userId: 7,
      billMonth: '2026-09',
      amount: 100,
      remainingAmount: 100,
      status: 'PENDING',
    });
    expect(createdBills[0].periodStart.toISOString()).toBe('2026-08-15T00:00:00.000Z');
    expect(createdBills[0].periodEnd.toISOString()).toBe('2026-09-14T23:59:59.999Z');
    expect(createdBills[0].dueAt.toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });

  it('allows rental confirmation to make available balance negative when total assets stay non-negative', async () => {
    const tx: any = {
      equipmentRentalBill: {
        findUnique: jest.fn().mockResolvedValue({
          id: 11,
          userId: 7,
          billMonth: '2026-07',
          remainingAmount: 120,
          amount: 120,
          status: 'PENDING',
        }),
        update: jest.fn().mockResolvedValue({ id: 11, status: 'PAID' }),
      },
      walletAccount: {
        findUnique: jest.fn().mockResolvedValue({
          availableBalance: 50,
          frozenBalance: 100,
        }),
        update: jest.fn().mockResolvedValue({
          availableBalance: -70,
          frozenBalance: 100,
        }),
      },
      walletTransaction: {
        create: jest.fn().mockResolvedValue({ id: 91 }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const service = new EquipmentRentalFeeService(prisma);

    const result = await service.confirmMyBill(7, 11);

    expect(result).toMatchObject({ id: 11, status: 'PAID' });
    expect(tx.walletAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 7 },
        data: { availableBalance: { decrement: 120 } },
      }),
    );
    expect(tx.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 7,
          bizType: 'EQUIPMENT_RENTAL_FEE',
          amount: 120,
          availableAfter: -70,
          frozenAfter: 100,
        }),
      }),
    );
  });

  it('rejects rental confirmation when total assets would become negative', async () => {
    const tx: any = {
      equipmentRentalBill: {
        findUnique: jest.fn().mockResolvedValue({
          id: 12,
          userId: 7,
          billMonth: '2026-07',
          remainingAmount: 180,
          amount: 180,
          status: 'PENDING',
        }),
      },
      walletAccount: {
        findUnique: jest.fn().mockResolvedValue({
          availableBalance: 50,
          frozenBalance: 100,
        }),
        update: jest.fn(),
      },
      walletTransaction: {
        create: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const service = new EquipmentRentalFeeService(prisma);

    await expect(service.confirmMyBill(7, 12)).rejects.toThrow('账户总资产不足');
    expect(tx.walletAccount.update).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('confirms external channel payment without touching wallet balance', async () => {
    const tx: any = {
      equipmentRentalBill: {
        findUnique: jest.fn().mockResolvedValue({
          id: 13,
          userId: 7,
          billMonth: '2026-07',
          remainingAmount: 120,
          amount: 120,
          status: 'PENDING',
        }),
        update: jest.fn().mockResolvedValue({ id: 13, status: 'PAID', walletTxId: null }),
      },
      walletAccount: {
        update: jest.fn(),
      },
      walletTransaction: {
        create: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const service = new EquipmentRentalFeeService(prisma);

    const result = await service.confirmPaidByOtherChannel(13, 1, '微信收款码已收');

    expect(result).toMatchObject({ id: 13, status: 'PAID', walletTxId: null });
    expect(tx.equipmentRentalBill.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 13 },
        data: expect.objectContaining({
          paidAmount: 120,
          remainingAmount: 0,
          status: 'PAID',
          walletTxId: null,
          remark: expect.stringContaining('微信收款码已收'),
        }),
      }),
    );
    expect(tx.walletAccount.update).not.toHaveBeenCalled();
    expect(tx.walletTransaction.create).not.toHaveBeenCalled();
  });
});
