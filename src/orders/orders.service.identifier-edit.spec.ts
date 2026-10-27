import { BadRequestException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { OrdersService } from './orders.service';

describe('OrdersService updateOrderCustomerIdentifier', () => {
  it('updates only customer identifier fields even when pricing fields are submitted', async () => {
    const order = {
      id: 12,
      status: OrderStatus.WAIT_ASSIGN,
      customerIdentifierType: 'ALIAS',
      customerGameId: null,
      customerOriginalIdentifier: '旧昵称',
    };
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(order),
        update: jest.fn().mockResolvedValue(order),
      },
    };
    const service = Object.create(OrdersService.prototype) as OrdersService;
    (service as any).prisma = prisma;
    (service as any).logOrderAction = jest.fn();
    (service as any).getOrderDetail = jest.fn().mockResolvedValue({...order, customerGameId: '998877'});

    await service.updateOrderCustomerIdentifier({
      id: 12,
      customerIdentifierType: 'GAME_ID',
      customerGameId: '998877',
      projectId: 999,
      receivableAmount: 0.01,
      paymentChannel: 'BALANCE',
    }, 7);

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: {id: 12},
      data: {
        customerIdentifierType: 'GAME_ID',
        customerGameId: '998877',
        customerOriginalIdentifier: '998877',
      },
    });
  });

  it('rejects an empty customer identifier', async () => {
    const service = Object.create(OrdersService.prototype) as OrdersService;
    (service as any).prisma = {order: {findUnique: jest.fn().mockResolvedValue({id: 12, status: OrderStatus.WAIT_ASSIGN})}};
    await expect(service.updateOrderCustomerIdentifier({id: 12, customerGameId: ''}, 7)).rejects.toThrow(
      new BadRequestException('客户标识不能为空'),
    );
  });
});
