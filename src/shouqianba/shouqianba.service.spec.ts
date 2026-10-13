import { ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ShouqianbaService } from './shouqianba.service';

describe('ShouqianbaService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SHOUQIANBA_VENDOR_SN: 'vendor-sn',
      SHOUQIANBA_VENDOR_KEY: 'vendor-key',
      SHOUQIANBA_APP_ID: 'app-id',
      SHOUQIANBA_DEVICE_ID: 'test-device',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('signs the exact serialized request body with MD5(body + key)', () => {
    const service = new ShouqianbaService({} as any, {} as any);
    const body = JSON.stringify({
      app_id: 'app-id',
      code: '12345678',
      device_id: 'test-device',
    });
    const expected = createHash('md5')
      .update(`${body}vendor-key`, 'utf8')
      .digest('hex');

    expect((service as any).sign(body, 'vendor-key')).toBe(expected);
  });

  it('rejects an invalid RSA callback signature', () => {
    const service = new ShouqianbaService({} as any, {} as any);

    expect(
      service.verifyCallback(
        Buffer.from('{"status":"SUCCESS"}'),
        'not-a-valid-signature',
      ),
    ).toBe(false);
  });

  it('blocks duplicate activation before making an external request', async () => {
    const prisma = {
      shouqianbaTerminal: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 1, deviceId: 'test-device' }),
      },
    };
    const service = new ShouqianbaService(prisma as any, {} as any);
    const postSpy = jest.spyOn(service as any, 'post');

    await expect(service.activate('12345678', true)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('queries the provider and reconciles the returned payment result', async () => {
    const prisma = {
      orderPayment: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 9, clientSn: 'BC9', providerSn: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      shouqianbaTerminal: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            terminalSn: 'terminal',
            terminalKeyIv: '00',
            terminalKeyTag: '00',
          }),
      },
    };
    const service = new ShouqianbaService(prisma as any, {} as any);
    jest.spyOn(service as any, 'decrypt').mockReturnValue('terminal-key');
    jest.spyOn(service as any, 'post').mockResolvedValue({
      result_code: '200',
      biz_response: {
        result_code: 'SUCCESS',
        data: {
          client_sn: 'BC9',
          status: 'SUCCESS',
          order_status: 'PAID',
          sn: 'SQB9',
          total_amount: '1',
        },
      },
    });
    const applySpy = jest
      .spyOn(service as any, 'applyProviderResult')
      .mockResolvedValue({ paidOrderId: 1 });

    await expect(service.queryPayment(9)).resolves.toEqual(
      expect.objectContaining({
        paymentId: 9,
        status: 'SUCCESS',
        orderStatus: 'PAID',
        clientSn: 'BC9',
      }),
    );
    expect(prisma.orderPayment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 9 },
        data: expect.objectContaining({ queryAttempts: { increment: 1 } }),
      }),
    );
    expect(applySpy).toHaveBeenCalledWith(
      expect.objectContaining({ client_sn: 'BC9' }),
      'QUERY',
    );
  });

  it('polls only payment attempts whose provider query interval is due', async () => {
    const now = new Date();
    const prisma = {
      orderPayment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 1,
            createdAt: new Date(now.getTime() - 30_000),
            lastQueriedAt: new Date(now.getTime() - 15_000),
          },
          {
            id: 2,
            createdAt: new Date(now.getTime() - 30_000),
            lastQueriedAt: new Date(now.getTime() - 2_000),
          },
        ]),
      },
    };
    const service = new ShouqianbaService(prisma as any, {} as any);
    const querySpy = jest
      .spyOn(service, 'queryPayment')
      .mockResolvedValue({} as any);

    await service.reconcilePendingPayments();

    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(querySpy).toHaveBeenCalledWith(1);
  });

  it('keeps the order waiting when any preselected player is not idle', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 12,
          isPaid: true,
          status: 'WAIT_ASSIGN',
          currentDispatchId: null,
          dispatcherId: 7,
          preselectedPlayerIds: [21, 22],
        }),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 21,
            workStatus: 'IDLE',
            status: 'ACTIVE',
            staffEmploymentStatus: 'ACTIVE',
          },
          {
            id: 22,
            workStatus: 'WORKING',
            status: 'ACTIVE',
            staffEmploymentStatus: 'ACTIVE',
          },
        ]),
      },
      orderDispatch: { create: jest.fn() },
      orderParticipant: { createMany: jest.fn() },
      userLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    };
    const service = new ShouqianbaService(prisma as any, {} as any);

    await (service as any).autoDispatchPreselectedPlayers(12);

    expect(tx.orderDispatch.create).not.toHaveBeenCalled();
    expect(tx.userLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'AUTO_DISPATCH_SKIPPED' }),
      }),
    );
  });

  it('creates the saved attribution group when online payment auto-dispatches', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 18,
          isPaid: true,
          status: 'WAIT_ASSIGN',
          currentDispatchId: null,
          dispatcherId: 7,
          preselectedPlayerIds: [21, 22],
          preselectedAttributionIds: [21],
          preselectedAttributionType: 'RENEWAL',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: 21,
              workStatus: 'IDLE',
              status: 'ACTIVE',
              staffEmploymentStatus: 'ACTIVE',
            },
            {
              id: 22,
              workStatus: 'IDLE',
              status: 'ACTIVE',
              staffEmploymentStatus: 'ACTIVE',
            },
          ])
          .mockResolvedValueOnce([
            { id: 21, name: '服务者A', phone: '13800000000' },
          ]),
      },
      excellentStaff: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ userId: 21, assignedAt: new Date() }]),
      },
      orderDispatch: { create: jest.fn().mockResolvedValue({ id: 31 }) },
      orderParticipant: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      orderRenewalGroup: { create: jest.fn().mockResolvedValue({ id: 41 }) },
      userLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    };
    const service = new ShouqianbaService(prisma as any, {} as any);

    await (service as any).autoDispatchPreselectedPlayers(18);

    expect(tx.orderRenewalGroup.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 18,
          dispatchId: 31,
          attributionType: 'RENEWAL',
          memberUserIds: [21],
          bonusEligibleUserIds: [21],
        }),
      }),
    );
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'WAIT_ACCEPT',
          isRenewal: true,
        }),
      }),
    );
  });
});
