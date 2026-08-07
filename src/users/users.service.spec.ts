import { StaffEmploymentStatus, UserType } from '@prisma/client';
import { UsersService } from './users.service';

describe('UsersService.create staff rejoin', () => {
  const actor = { userType: UserType.ADMIN, permissions: ['users:staff:page', 'users:staff:create:button'] };

  const createService = (prisma: any, wallet: any = {}, staffRuleEngineService: any = {}) => {
    prisma.role = prisma.role || {
      findUnique: jest.fn().mockResolvedValue({ id: 3, name: '陪玩' }),
      findFirst: jest.fn().mockResolvedValue({ id: 3, name: '陪玩' }),
    };
    return new UsersService(
      prisma,
      {
        ensureWalletAccount: jest.fn().mockResolvedValue(undefined),
        ...wallet,
      } as any,
      {
        getConfig: jest.fn().mockResolvedValue({ tags: [], rules: [], defaultRule: { quitCoolingDays: 180 } }),
        resolveMatchedRule: jest.fn().mockReturnValue({
          quitCoolingDays: 180,
          depositForfeitDays: 0,
          depositAmount: 500,
          firstWithdrawMinBalance: 1000,
          firstWithdrawMinAcceptedDays: 15,
        }),
        normalizeUserTags: jest.fn((input: any) => (Array.isArray(input) ? input : [])),
        ...staffRuleEngineService,
      } as any,
    );
  };

  it('rejects multiple staff rule groups when creating staff', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };
    const service = createService(prisma);

    await expect(
      service.create(
        {
          phone: '13800138000',
          password: '123456',
          userType: UserType.STAFF,
          realName: '赵六',
          idCard: '510000199001010099',
          staffTags: ['group_a', 'group_b'],
        } as any,
        1,
        actor,
      ),
    ).rejects.toThrow('员工规则分组仅支持选择一个');
  });

  it('requires confirmation when exited staff is still in cooling period', async () => {
    const cooldownUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 9,
            userType: UserType.STAFF,
            phone: '13800138001',
            realName: '张三',
            idCard: '510000199001010000',
            staffTags: [],
            staffEmploymentStatus: StaffEmploymentStatus.EXITED,
            staffCooldownUntil: cooldownUntil,
            staffExitedAt: new Date(),
            walletAccount: {
              availableBalance: 0,
              frozenBalance: 0,
              earningFrozenBalance: 0,
              withdrawFrozenBalance: 0,
              depositBalance: 0,
            },
          },
        ]),
      },
    };
    const service = createService(prisma);

    await expect(
      service.create(
        {
          phone: '13800138001',
          password: '123456',
          userType: UserType.STAFF,
          realName: '张三',
          idCard: '510000199001010000',
          staffTags: ['default_staff'],
        } as any,
        1,
        actor,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'STAFF_REJOIN_COOLDOWN_CONFIRM_REQUIRED',
      }),
    });
  });

  it('rejects blacklisted staff rejoin', async () => {
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 10,
            userType: UserType.STAFF,
            phone: '13800138002',
            realName: '李四',
            idCard: '510000199001010001',
            staffEmploymentStatus: StaffEmploymentStatus.BLACKLISTED,
          },
        ]),
      },
    };
    const service = createService(prisma);

    await expect(
      service.create(
        {
          phone: '13800138002',
          password: '123456',
          userType: UserType.STAFF,
          realName: '李四',
          idCard: '510000199001010001',
          staffTags: ['default_staff'],
        } as any,
        1,
        actor,
      ),
    ).rejects.toThrow('该员工已加入黑名单，不允许重新入店');
  });

  it('rejoins exited staff and clears positive wallet balances only', async () => {
    const oldStaff = {
      id: 11,
      userType: UserType.STAFF,
      phone: '13800138003',
      realName: '王五',
      idCard: '510000199001010002',
      staffTags: [],
      staffEmploymentStatus: StaffEmploymentStatus.EXITED,
      staffCooldownUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
      staffExitedAt: new Date(Date.now() - 181 * 24 * 60 * 60 * 1000),
      walletAccount: {
        availableBalance: 120,
        frozenBalance: -30,
        earningFrozenBalance: 40,
        withdrawFrozenBalance: 0,
        depositBalance: 50,
      },
    };
    const tx: any = {
      walletAccount: {
        findUnique: jest.fn().mockResolvedValue(oldStaff.walletAccount),
        update: jest.fn().mockResolvedValue({}),
      },
      userLog: {
        create: jest.fn().mockResolvedValue({ id: 99 }),
      },
      walletTransaction: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 199 }),
      },
      walletHold: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      walletDepositTransaction: {
        create: jest.fn().mockResolvedValue({ id: 299 }),
      },
      user: {
        update: jest.fn().mockResolvedValue({
          ...oldStaff,
          staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
        }),
      },
    };
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue(oldStaff),
        findMany: jest.fn().mockResolvedValue([oldStaff]),
      },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const service = createService(prisma);

    await service.create(
      {
        phone: '13800138003',
        password: '123456',
        userType: UserType.STAFF,
        realName: '王五',
        idCard: '510000199001010002',
        staffTags: ['default_staff'],
      } as any,
      1,
      actor,
    );

    expect(tx.walletAccount.update).toHaveBeenCalledWith({
      where: { userId: 11 },
      data: {
        availableBalance: 0,
        earningFrozenBalance: 0,
        depositBalance: 0,
      },
    });
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 11 },
        data: expect.objectContaining({
          staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
          staffCooldownUntil: null,
          staffExitedAt: null,
          canWithdraw: true,
        }),
      }),
    );
  });
});

describe('UsersService staff exit actions', () => {
  const actor = { userType: UserType.ADMIN, permissions: ['users:staff:page', 'users:staff:exit:button', 'users:staff:clear:button'] };

  const createService = (prisma: any, staffRuleEngineService: any = {}) => {
    return new UsersService(
      prisma,
      {
        ensureWalletAccount: jest.fn().mockResolvedValue(undefined),
      } as any,
      {
        getConfig: jest.fn().mockResolvedValue({ tags: [], rules: [], defaultRule: { quitCoolingDays: 180, depositForfeitDays: 90, depositAmount: 500 } }),
        resolveMatchedRule: jest.fn().mockReturnValue({
          quitCoolingDays: 180,
          depositForfeitDays: 90,
          depositAmount: 500,
          firstWithdrawMinBalance: 1000,
          firstWithdrawMinAcceptedDays: 15,
        }),
        normalizeUserTags: jest.fn((input: any) => (Array.isArray(input) ? input : [])),
        ...staffRuleEngineService,
      } as any,
    );
  };

  const exitedStaff = {
    id: 21,
    userType: UserType.STAFF,
    staffEmploymentStatus: StaffEmploymentStatus.EXITED,
    walletAccount: {
      availableBalance: 0,
      frozenBalance: 0,
      depositBalance: 0,
    },
  };

  it('rejects exit preview for exited staff', async () => {
    const service = createService({
      user: {
        findUnique: jest.fn().mockResolvedValue(exitedStaff),
      },
    });

    await expect(service.getStaffExitPreview(21, actor)).rejects.toThrow('该员工已退店，不支持重复退店或清退');
  });

  it('rejects repeated exit for exited staff', async () => {
    const service = createService({
      user: {
        findUnique: jest.fn().mockResolvedValue(exitedStaff),
      },
      $transaction: jest.fn(),
    });

    await expect(service.exitStaffShop(21, { mode: 'RELEASE_TO_AVAILABLE' } as any, 1, actor)).rejects.toThrow(
      '该员工已退店，不支持重复退店或清退',
    );
  });

  it('rejects clear for exited staff', async () => {
    const service = createService({
      user: {
        findUnique: jest.fn().mockResolvedValue(exitedStaff),
      },
      $transaction: jest.fn(),
    });

    await expect(service.clearStaffAssets(21, { remark: '重复清退' } as any, 1, actor)).rejects.toThrow(
      '该员工已退店，不支持重复退店或清退',
    );
  });

  it('forfeits deposit when effective accepted orders are below the refund threshold', async () => {
    const activeStaff = {
      id: 22,
      userType: UserType.STAFF,
      createdAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
      offlineJoinedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
      staffTags: [],
      staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
      walletAccount: {
        availableBalance: 1000,
        frozenBalance: 0,
        depositBalance: 500,
      },
    };
    const service = createService({
      user: {
        findUnique: jest.fn().mockResolvedValue(activeStaff),
      },
      orderParticipant: {
        count: jest.fn().mockResolvedValue(49),
      },
    });

    const preview = await service.getStaffExitPreview(22, actor);

    expect(preview.effectiveAcceptedOrderCount).toBe(49);
    expect(preview.isDepositForfeitByOrders).toBe(true);
    expect(preview.refundDepositAmount).toBe(0);
    expect(preview.forfeitDepositAmount).toBe(500);
    expect(preview.finalAvailableBalance).toBe(1000);
  });

  it('deducts unpaid deposit shortfall from available balance on staff exit', async () => {
    const activeStaff = {
      id: 23,
      userType: UserType.STAFF,
      createdAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
      offlineJoinedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
      staffTags: [],
      staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
      walletAccount: {
        availableBalance: 800,
        frozenBalance: 0,
        depositBalance: 200,
      },
    };
    const tx: any = {
      userLog: {
        create: jest.fn().mockResolvedValue({ id: 88 }),
      },
      user: {
        update: jest.fn().mockResolvedValue({
          ...activeStaff,
          staffEmploymentStatus: StaffEmploymentStatus.EXITED,
        }),
      },
      walletAccount: {
        update: jest.fn().mockResolvedValue({
          availableBalance: 500,
          frozenBalance: 0,
        }),
      },
      walletTransaction: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 188 }),
      },
      walletHold: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      walletDepositTransaction: {
        create: jest.fn().mockResolvedValue({ id: 288 }),
      },
    };
    const service = createService({
      user: {
        findUnique: jest.fn().mockResolvedValue(activeStaff),
      },
      orderParticipant: {
        count: jest.fn().mockResolvedValue(60),
      },
      $transaction: jest.fn((callback) => callback(tx)),
    });

    await service.exitStaffShop(23, { mode: 'RELEASE_TO_AVAILABLE' } as any, 1, actor);

    expect(tx.walletAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 23 },
        data: expect.objectContaining({
          availableBalance: { increment: -300 },
          depositBalance: 0,
        }),
      }),
    );
    expect(tx.walletDepositTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: -200,
          remark: '员工退店，保证金按规则不退',
        }),
      }),
    );
    expect(tx.walletDepositTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amount: -300,
          remark: '员工退店，保证金未缴满，从余额补扣后不退',
        }),
      }),
    );
    expect(tx.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          direction: 'OUT',
          bizType: 'STAFF_EXIT_CLEAR',
          amount: 300,
        }),
      }),
    );
  });

  it('does not make available balance negative when deposit shortfall exceeds remaining balance', async () => {
    const activeStaff = {
      id: 24,
      userType: UserType.STAFF,
      createdAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
      offlineJoinedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
      staffTags: [],
      staffEmploymentStatus: StaffEmploymentStatus.ACTIVE,
      walletAccount: {
        availableBalance: 100,
        frozenBalance: 0,
        depositBalance: 200,
      },
    };
    const tx: any = {
      userLog: {
        create: jest.fn().mockResolvedValue({ id: 89 }),
      },
      user: {
        update: jest.fn().mockResolvedValue({
          ...activeStaff,
          staffEmploymentStatus: StaffEmploymentStatus.EXITED,
        }),
      },
      walletAccount: {
        update: jest.fn().mockResolvedValue({
          availableBalance: 0,
          frozenBalance: 0,
        }),
      },
      walletTransaction: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 189 }),
      },
      walletHold: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      walletDepositTransaction: {
        create: jest.fn().mockResolvedValue({ id: 289 }),
      },
    };
    const service = createService({
      user: {
        findUnique: jest.fn().mockResolvedValue(activeStaff),
      },
      orderParticipant: {
        count: jest.fn().mockResolvedValue(60),
      },
      $transaction: jest.fn((callback) => callback(tx)),
    });

    const preview = await service.getStaffExitPreview(24, actor);

    expect(preview.depositTopUpForfeitAmount).toBe(100);
    expect(preview.depositTopUpUnpaidAmount).toBe(200);
    expect(preview.finalAvailableBalance).toBe(0);

    await service.exitStaffShop(24, { mode: 'RELEASE_TO_AVAILABLE' } as any, 1, actor);

    expect(tx.walletAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          availableBalance: { increment: -100 },
          depositBalance: 0,
        }),
      }),
    );
    expect(tx.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          direction: 'OUT',
          amount: 100,
        }),
      }),
    );
  });
});
