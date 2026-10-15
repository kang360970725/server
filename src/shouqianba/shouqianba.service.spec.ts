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
            lastCheckedInAt: new Date(),
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

  it('rechecks expired online payments so orders can converge to cancelled', async () => {
    const prisma = {
      orderPayment: {
        findMany: jest.fn().mockResolvedValue([{ id: 31 }, { id: 32 }]),
      },
    };
    const service = new ShouqianbaService(prisma as any, {} as any);
    const querySpy = jest.spyOn(service, 'queryPayment').mockResolvedValue({} as any);

    await service.reconcileExpiredOnlineOrders();

    expect(querySpy.mock.calls.map(([id]) => id)).toEqual([31, 32]);
    expect(prisma.orderPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          purpose: 'ORDER',
          expiresAt: expect.objectContaining({ lte: expect.any(Date) }),
          order: expect.objectContaining({ status: 'WAIT_PAYMENT', isPaid: false }),
        }),
      }),
    );
  });

  it('cancels an unpaid order and releases its coupon after provider confirms expiry', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      orderPayment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 41,
          orderId: 51,
          clientSn: 'BC51',
          status: 'PENDING',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 51,
          autoSerial: 'VTEST51',
          status: 'WAIT_PAYMENT',
          isPaid: false,
          latestPaymentId: 41,
          currentDispatchId: null,
          dispatcherId: 7,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      userCoupon: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      userLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn(async (handler: any) => handler(tx)),
    };
    const service = new ShouqianbaService(prisma as any, {} as any);

    await (service as any).applyProviderResult(
      { client_sn: 'BC51', status: 'FAIL', order_status: 'EXPIRED' },
      'QUERY',
    );

    expect(tx.userCoupon.updateMany).toHaveBeenCalledWith({
      where: { orderId: 51, status: 'UNUSED' },
      data: { orderId: null },
    });
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 51 },
        data: expect.objectContaining({ status: 'CANCELLED', payStatus: 'FAILED' }),
      }),
    );
    expect(tx.userLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'AUTO_CANCEL_UNPAID_ORDER' }) }),
    );
  });

  it('uses five-second polling for the first two minutes, ten seconds afterwards, and stops after six minutes', async () => {
    const now = Date.now();
    const prisma = {
      orderPayment: {
        findMany: jest.fn().mockResolvedValue([
          { id: 1, createdAt: new Date(now - 60_000), lastQueriedAt: new Date(now - 6_000) },
          { id: 2, createdAt: new Date(now - 180_000), lastQueriedAt: new Date(now - 9_000) },
          { id: 3, createdAt: new Date(now - 180_000), lastQueriedAt: new Date(now - 11_000) },
          { id: 4, createdAt: new Date(now - 361_000), lastQueriedAt: null },
        ]),
      },
    };
    const service = new ShouqianbaService(prisma as any, {} as any);
    const querySpy = jest.spyOn(service, 'queryPayment').mockResolvedValue({} as any);

    await service.reconcilePendingPayments();

    expect(querySpy.mock.calls.map(([id]) => id)).toEqual([1, 3]);
    expect(prisma.orderPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      }),
    );
  });

  it('checks in automatically before the first business request of the day', async () => {
    const staleTerminal = {
      id: 1,
      terminalSn: 'terminal-old',
      terminalKeyIv: '00',
      terminalKeyTag: '00',
      lastCheckedInAt: null,
    };
    const freshTerminal = {
      ...staleTerminal,
      terminalSn: 'terminal-new',
      lastCheckedInAt: new Date(),
    };
    const prisma = {
      orderPayment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 9,
          clientSn: 'BC9',
          providerSn: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      shouqianbaTerminal: {
        findUnique: jest.fn().mockResolvedValueOnce(staleTerminal).mockResolvedValue(freshTerminal),
      },
    };
    const service = new ShouqianbaService(prisma as any, {} as any);
    const checkinSpy = jest.spyOn(service, 'checkin').mockResolvedValue(freshTerminal as any);
    jest.spyOn(service as any, 'decrypt').mockReturnValue('terminal-key');
    jest.spyOn(service as any, 'post').mockResolvedValue({
      result_code: '200',
      biz_response: {
        result_code: 'SUCCESS',
        data: { client_sn: 'BC9', status: 'SUCCESS', order_status: 'PAID' },
      },
    });
    jest.spyOn(service as any, 'applyProviderResult').mockResolvedValue({ paidOrderId: 1 });

    await service.queryPayment(9);

    expect(checkinSpy).toHaveBeenCalledTimes(1);
    expect((service as any).post).toHaveBeenCalledWith(
      '/upay/v2/query',
      expect.objectContaining({ terminal_sn: 'terminal-new' }),
      'terminal-new',
      'terminal-key',
    );
  });

  it('coalesces concurrent first requests into a single daily check-in', async () => {
    const staleTerminal = { lastCheckedInAt: null };
    const freshTerminal = { lastCheckedInAt: new Date() };
    const prisma = {
      shouqianbaTerminal: {
        findUnique: jest.fn().mockResolvedValue(freshTerminal),
      },
    };
    const service = new ShouqianbaService(prisma as any, {} as any);
    let finishCheckin: (value: any) => void = () => undefined;
    const checkinPending = new Promise((resolve) => {
      finishCheckin = resolve;
    });
    const checkinSpy = jest
      .spyOn(service, 'checkin')
      .mockReturnValue(checkinPending as any);

    const first = (service as any).ensureDailyCheckin(staleTerminal);
    const second = (service as any).ensureDailyCheckin(staleTerminal);
    finishCheckin(freshTerminal);

    await expect(Promise.all([first, second])).resolves.toEqual([
      freshTerminal,
      freshTerminal,
    ]);
    expect(checkinSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a query when the communication layer succeeds but the business layer fails', async () => {
    const prisma = {
      orderPayment: {
        findUnique: jest.fn().mockResolvedValue({ id: 9, clientSn: 'BC9', providerSn: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      shouqianbaTerminal: {
        findUnique: jest.fn().mockResolvedValue({
          terminalSn: 'terminal',
          terminalKeyIv: '00',
          terminalKeyTag: '00',
          lastCheckedInAt: new Date(),
        }),
      },
    };
    const service = new ShouqianbaService(prisma as any, {} as any);
    jest.spyOn(service as any, 'decrypt').mockReturnValue('terminal-key');
    jest.spyOn(service as any, 'post').mockResolvedValue({
      result_code: '200',
      biz_response: { result_code: 'FAIL', error_message: '订单不存在' },
    });

    await expect(service.queryPayment(9)).rejects.toThrow('订单不存在');
  });

  it('writes a redacted audit log without terminal keys or activation codes', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = new ShouqianbaService(
      { shouqianbaApiLog: { create } } as any,
      {} as any,
    );

    await (service as any).recordApiLog({
      endpoint: '/terminal/activate',
      requestPayload: { code: '12345678', app_id: 'app-id' },
      responsePayload: {
        result_code: '200',
        biz_response: {
          terminal_key: 'secret',
          terminalKey: 'also-secret',
          terminal_sn: 'terminal',
        },
      },
      success: true,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestPayload: expect.objectContaining({ code: '[REDACTED]' }),
          responsePayload: expect.objectContaining({
            biz_response: expect.objectContaining({
              terminal_key: '[REDACTED]',
              terminalKey: '[REDACTED]',
            }),
          }),
        }),
      }),
    );
  });

  it('confirms a final callback once more through the query interface before acknowledging it', async () => {
    const prisma = {
      orderPayment: { findUnique: jest.fn().mockResolvedValue({ id: 9, clientSn: 'BC9' }) },
    };
    const service = new ShouqianbaService(prisma as any, {} as any);
    jest.spyOn(service, 'verifyCallback').mockReturnValue(true);
    jest.spyOn(service as any, 'applyProviderResult').mockResolvedValue({ paidOrderId: 1 });
    const querySpy = jest.spyOn(service, 'queryPayment').mockResolvedValue({} as any);

    await expect(
      service.handleCallback(
        Buffer.from('{}'),
        'signature',
        { client_sn: 'BC9', status: 'SUCCESS', order_status: 'PAID' },
      ),
    ).resolves.toBe('success');
    expect(querySpy).toHaveBeenCalledWith(9);
  });

  it.each([
    { amountFen: 100, orderStatus: 'REFUNDED' },
    { amountFen: 40, orderStatus: 'PARTIAL_REFUNDED' },
  ])('accepts final full and partial refund results: $orderStatus', async ({ amountFen, orderStatus }) => {
    const prisma = {
      orderPayment: {
        findUnique: jest.fn().mockResolvedValue({ id: 9, clientSn: 'BC9', providerSn: 'SQB9' }),
      },
      shouqianbaTerminal: {
        findUnique: jest.fn().mockResolvedValue({
          terminalSn: 'terminal',
          terminalKeyIv: '00',
          terminalKeyTag: '00',
          lastCheckedInAt: new Date(),
        }),
      },
    };
    const service = new ShouqianbaService(prisma as any, {} as any);
    jest.spyOn(service as any, 'decrypt').mockReturnValue('terminal-key');
    const postSpy = jest.spyOn(service as any, 'post').mockResolvedValue({
      result_code: '200',
      biz_response: {
        result_code: 'REFUND_SUCCESS',
        data: {
          client_tsn: `RF${amountFen}`,
          status: 'SUCCESS',
          order_status: orderStatus,
        },
      },
    });

    await expect(
      service.refundPayment({
        paymentId: 9,
        refundRequestNo: `RF${amountFen}`,
        amountFen,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'SUCCESS', orderStatus }),
    );
    expect(postSpy).toHaveBeenCalledWith(
      '/upay/v2/refund',
      expect.objectContaining({ refund_amount: String(amountFen), sn: 'SQB9' }),
      'terminal',
      'terminal-key',
    );
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
