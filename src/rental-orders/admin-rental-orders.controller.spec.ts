import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AdminRentalOrdersController } from './admin-rental-orders.controller';

describe('admin rental permissions', () => {
  it.each([
    ['list', 'rental-orders:page'], ['detail', 'rental-orders:page'],
    ['create', 'rental-orders:create:button'], ['settle', 'rental-orders:settle:button'], ['void', 'rental-orders:void:button'],
  ])('%s requires its own permission', (method, permission) => {
    const handler = AdminRentalOrdersController.prototype[method];
    expect(Reflect.getMetadata('permissions', handler)).toEqual([permission]);
    const guard = new PermissionsGuard(new Reflector());
    const context = (permissions: string[]) => ({ getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ user: { permissions } }) }),
    } as any);
    expect(() => guard.canActivate(context(['users:staff-rental-risk:page']))).toThrow('权限不足');
    expect(guard.canActivate(context([permission]))).toBe(true);
  });
  it('uses authenticated operator instead of payload operator', () => {
    const service: any = { create: jest.fn() };
    const controller = new AdminRentalOrdersController(service);
    controller.create({ createdBy: 999 } as any, { user: { userId: 3 } });
    expect(service.create).toHaveBeenCalledWith({ createdBy: 999 }, 3);
  });
});
