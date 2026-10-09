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
    prisma.userLog = { create: jest.fn() };
    prisma.$transaction = jest.fn((callback) => callback(prisma));
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
    prisma.userLog = { create: jest.fn() };
    prisma.$transaction = jest.fn((callback) => callback(prisma));
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

  it('generates the previous natural-month bill on the next month first day', async () => {
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
    expect(createdBills[0].periodStart.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(createdBills[0].periodEnd.toISOString()).toBe('2026-09-30T23:59:59.000Z');
    expect(createdBills[0].dueAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('generates one bill per contract when a staff user has multiple active configurations', async () => {
    const createdBills: any[] = [];
    const prisma = {
      equipmentRentalContract: {
        findMany: jest.fn().mockResolvedValue([
          { id: 31, userId: 7, status: 'ACTIVE', monthlyAmount: 100, startDate: new Date(Date.UTC(2026, 6, 15)), endDate: null },
          { id: 32, userId: 7, status: 'ACTIVE', monthlyAmount: 80, startDate: new Date(Date.UTC(2026, 7, 20)), endDate: null },
        ]),
      },
      equipmentRentalBill: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn((payload) => {
          createdBills.push(payload.data);
          return Promise.resolve({ id: 40 + createdBills.length, ...payload.data });
        }),
      },
    } as any;
    const service = new EquipmentRentalFeeService(prisma);

    await expect(service.generateBillsForMonth('2026-09')).resolves.toMatchObject({ affected: 2 });
    expect(createdBills).toEqual(expect.arrayContaining([
      expect.objectContaining({ contractId: 31, userId: 7, billMonth: '2026-09', amount: 100 }),
      expect.objectContaining({ contractId: 32, userId: 7, billMonth: '2026-09', amount: 80 }),
    ]));
    expect(prisma.equipmentRentalBill.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { contractId_billMonth: { contractId: 31, billMonth: '2026-09' } },
    }));
    expect(prisma.equipmentRentalBill.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { contractId_billMonth: { contractId: 32, billMonth: '2026-09' } },
    }));
  });

  it('creates a prorated equipment bill through the staff exit date', async () => {
    let createdBill: any;
    const tx: any = {
      equipmentRentalContract: {
        findMany: jest.fn().mockResolvedValue([{
          id: 31,
          userId: 7,
          status: 'ACTIVE',
          monthlyAmount: 310,
          startDate: new Date('2026-10-01T00:00:00.000Z'),
          endDate: null,
        }]),
      },
      equipmentRentalBill: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => {
          createdBill = { id: 91, ...data };
          return createdBill;
        }),
        findMany: jest.fn().mockImplementation(() => [createdBill]),
      },
    };
    const service = new EquipmentRentalFeeService({} as any);

    const result = await service.prepareStaffExitSettlementTx(
      tx,
      7,
      undefined,
      new Date('2026-10-10T08:00:00.000Z'),
    );

    expect(result.totalAmount).toBe(100);
    expect(createdBill).toMatchObject({
      billMonth: '2026-10',
      amount: 100,
      remainingAmount: 100,
      periodStart: new Date('2026-10-01T00:00:00.000Z'),
      periodEnd: new Date('2026-10-10T00:00:00.000Z'),
      dueAt: new Date('2026-10-10T00:00:00.000Z'),
    });
  });

  it('reports the correct recalculated amount for a paid bill and offers only the overpaid difference', async () => {
    const prisma = {
      equipmentRentalContract: {
        findMany: jest.fn().mockResolvedValue([{
          id: 31,
          userId: 7,
          status: 'ACTIVE',
          monthlyAmount: 80,
          startDate: new Date(Date.UTC(2026, 7, 15)),
          endDate: null,
        }]),
      },
      equipmentRentalBill: {
        findUnique: jest.fn().mockResolvedValue({
          id: 41,
          userId: 7,
          billMonth: '2026-09',
          status: 'PAID',
          amount: 100,
          paidAmount: 100,
          walletTxId: 91,
          user: { id: 7, name: '测试服务者' },
          walletTx: { id: 91, amount: 100, sourceType: 'EQUIPMENT_RENTAL_BILL_SELF_CONFIRM', reversals: [] },
        }),
        update: jest.fn(),
      },
      userLog: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any;
    const service = new EquipmentRentalFeeService(prisma);

    await expect(service.generateBillsForMonth('2026-09', 1)).resolves.toMatchObject({
      affected: 0,
      correct: 0,
      reconciliations: [{
        billId: 41,
        currentAmount: 100,
        correctAmount: 80,
        difference: 20,
        canRefund: true,
      }],
    });
    expect(prisma.equipmentRentalBill.update).not.toHaveBeenCalled();
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
      userLog: { create: jest.fn() },
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

  it('allows an unpaid external-channel bill to be confirmed with an adjusted amount and required reason', async () => {
    const tx: any = {
      userLog: { create: jest.fn() },
      equipmentRentalBill: {
        findUnique: jest.fn().mockResolvedValue({
          id: 14,
          userId: 7,
          billMonth: '2026-07',
          remainingAmount: 120,
          amount: 120,
          status: 'PENDING',
        }),
        update: jest.fn().mockResolvedValue({ id: 14, amount: 88, paidAmount: 88, status: 'PAID' }),
      },
    };
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) } as any;
    const service = new EquipmentRentalFeeService(prisma);

    await service.confirmPaidByOtherChannel(14, 1, '线下实收调整', 88);

    expect(tx.equipmentRentalBill.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 14 },
      data: expect.objectContaining({ amount: 88, paidAmount: 88, remainingAmount: 0, status: 'PAID' }),
    }));
    await expect(service.confirmPaidByOtherChannel(14, 1, '  ', 88)).rejects.toThrow('请填写其他渠道缴费说明');
  });

  it('refunds a wallet-paid equipment bill partially and links the refund to the original transaction', async () => {
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 15 }]),
      userLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 501 }),
        update: jest.fn().mockResolvedValue({ id: 501 }),
      },
      equipmentRentalBill: {
        findUnique: jest.fn().mockResolvedValue({
          id: 15,
          userId: 7,
          amount: 120,
          paidAmount: 120,
          remainingAmount: 0,
          status: 'PAID',
          walletTxId: 91,
          walletTx: {
            id: 91,
            direction: 'OUT',
            bizType: 'EQUIPMENT_RENTAL_FEE',
            status: 'AVAILABLE',
            amount: 120,
            sourceType: 'EQUIPMENT_RENTAL_BILL_SELF_CONFIRM',
            reversals: [{ amount: 20, status: 'AVAILABLE' }],
          },
        }),
        update: jest.fn().mockResolvedValue({ id: 15, amount: 90, paidAmount: 90, status: 'PAID' }),
      },
      walletAccount: {
        update: jest.fn().mockResolvedValue({ availableBalance: 130, frozenBalance: 40 }),
      },
      walletTransaction: {
        create: jest.fn().mockResolvedValue({ id: 92 }),
      },
    };
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) } as any;
    const service = new EquipmentRentalFeeService(prisma);

    await expect(service.refundBill(15, 30, '重算后退还差额', 1)).resolves.toMatchObject({
      id: 15,
      amount: 90,
      paidAmount: 90,
      refundedAmount: 50,
      refundableAmount: 70,
    });
    expect(tx.walletAccount.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 7 },
      data: { availableBalance: { increment: 30 } },
    }));
    expect(tx.walletTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        direction: 'IN',
        bizType: 'EQUIPMENT_RENTAL_FEE',
        sourceType: 'EQUIPMENT_RENTAL_BILL_REFUND',
        sourceId: 501,
        reversalOfTxId: 91,
        amount: 30,
      }),
    }));
  });

  it('rejects refund when the bill has no wallet payment flow', async () => {
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 16 }]),
      userLog: { findFirst: jest.fn().mockResolvedValue(null) },
      equipmentRentalBill: {
        findUnique: jest.fn().mockResolvedValue({ id: 16, walletTxId: null, walletTx: null }),
      },
    };
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) } as any;
    const service = new EquipmentRentalFeeService(prisma);

    await expect(service.refundBill(16, 10, '测试退费', 1)).rejects.toThrow('没有钱包支付流水');
  });

  it('rejects refund for an admin-paid equipment bill even when it has a wallet flow', async () => {
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 17 }]),
      userLog: { findFirst: jest.fn().mockResolvedValue({ id: 601 }) },
      equipmentRentalBill: {
        findUnique: jest.fn().mockResolvedValue({
          id: 17,
          walletTxId: 93,
          walletTx: {
            id: 93,
            direction: 'OUT',
            bizType: 'EQUIPMENT_RENTAL_FEE',
            status: 'AVAILABLE',
            amount: 100,
            sourceType: 'EQUIPMENT_RENTAL_BILL_ADMIN_PAY',
            reversals: [],
          },
        }),
      },
    };
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) } as any;
    const service = new EquipmentRentalFeeService(prisma);

    await expect(service.refundBill(17, 10, '测试退费', 1)).rejects.toThrow('仅服务者自行确认扣缴');
  });

  it('only reserves pending rental bills within 24 hours before their due time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-13T00:00:00.000Z'));
    const aggregate = jest.fn().mockResolvedValue({ _sum: { remainingAmount: 0 } });
    const db = {
      equipmentRentalBill: {
        aggregate,
        findMany: jest.fn().mockResolvedValue([{ id: 81, contractId: 31 }]),
      },
      equipmentRentalContract: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;
    const service = new EquipmentRentalFeeService({} as any);

    await expect(service.getWithdrawalObligationTx(db, 7)).resolves.toMatchObject({
      outstanding: 0,
      upcoming: 0,
      totalObligation: 0,
    });
    expect(aggregate).toHaveBeenCalledWith({
      where: {
        userId: 7,
        status: 'PENDING',
        OR: [
          { dueAt: { lte: new Date('2026-09-14T00:00:00.000Z') } },
          { dueAt: null },
        ],
      },
      _sum: { remainingAmount: true },
    });
    jest.useRealTimers();
  });

  it('does not reserve an ungenerated future service-month bill before it is due', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T00:00:00.000Z'));
    const db = {
      equipmentRentalBill: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { remainingAmount: 0 } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      equipmentRentalContract: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 31,
            monthlyAmount: 120,
            startDate: new Date('2026-07-01T00:00:00.000Z'),
            endDate: null,
            status: 'ACTIVE',
          },
        ]),
      },
    } as any;
    const service = new EquipmentRentalFeeService({} as any);

    await expect(service.getWithdrawalObligationTx(db, 7)).resolves.toMatchObject({
      outstanding: 0,
      upcoming: 0,
      totalObligation: 0,
      nextMonth: '2026-09',
    });
    jest.useRealTimers();
  });
});
