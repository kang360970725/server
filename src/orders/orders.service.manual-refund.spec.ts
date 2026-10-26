import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { OrdersService } from './orders.service';

describe('OrdersService confirmManualRefund', () => {
  const pendingRefund = {
    id: 303,
    orderId: 13875,
    refundNo: 'RMNAPFMVOOOK6K',
    status: 'MANUAL_REQUIRED',
    amount: 108,
    refundedAt: new Date('2026-10-26T03:15:07.000Z'),
    createdAt: new Date('2026-10-26T03:15:07.000Z'),
    raw: null,
    order: { id: 13875, autoSerial: 'V01HSHX7M7AW', status: OrderStatus.REFUNDED },
  };

  const createService = (refund: any = pendingRefund) => {
    const orderRefund = {
      findUnique: jest.fn().mockResolvedValue(refund),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = {
      orderRefund,
      $transaction: jest.fn(async (callback: any) => callback({
        orderRefund: {
          ...orderRefund,
          findUnique: jest.fn().mockResolvedValue({ ...refund, status: 'SUCCESS', refundedAt: new Date() }),
        },
      })),
    };
    const service = Object.create(OrdersService.prototype) as OrdersService;
    (service as any).prisma = prisma;
    (service as any).logOrderAction = jest.fn().mockResolvedValue(undefined);
    return { service, prisma, orderRefund };
  };

  it('only closes the pending refund record and records confirmation metadata', async () => {
    const { service, orderRefund } = createService();

    await expect(service.confirmManualRefund(303, 9, '微信转账凭证 20261026001')).resolves.toEqual(
      expect.objectContaining({ success: true, idempotent: false, refundId: 303, status: 'SUCCESS' }),
    );
    expect(orderRefund.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 303, status: 'MANUAL_REQUIRED' },
      data: expect.objectContaining({ status: 'SUCCESS' }),
    }));
    const updateData = orderRefund.updateMany.mock.calls[0][0].data;
    expect(updateData.raw).toEqual(expect.objectContaining({
      manualOfflineRefundCompleted: true,
      manualRefundConfirmedBy: 9,
      manualRefundConfirmationRemark: '微信转账凭证 20261026001',
    }));
  });

  it('is idempotent after the same manual refund was already confirmed', async () => {
    const { service, prisma, orderRefund } = createService({
      ...pendingRefund,
      status: 'SUCCESS',
      raw: { manualOfflineRefundCompleted: true },
    });

    await expect(service.confirmManualRefund(303, 9, '重复确认')).resolves.toEqual(
      expect.objectContaining({ success: true, idempotent: true }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(orderRefund.updateMany).not.toHaveBeenCalled();
  });

  it('rejects confirmation without a verifiable remark', async () => {
    const { service } = createService();
    await expect(service.confirmManualRefund(303, 9, ' ')).rejects.toThrow(
      new BadRequestException('请填写线下退款凭证或确认备注'),
    );
  });
});
