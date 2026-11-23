import { ForbiddenException } from '@nestjs/common';
import { UserStatus, UserType } from '@prisma/client';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy admin portal isolation', () => {
  let strategy: JwtStrategy;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 20,
          phone: '13800000020',
          name: '注册用户',
          userType: UserType.REGISTERED_USER,
          status: UserStatus.ACTIVE,
          roleId: null,
          Role: null,
        }),
        update: jest.fn(),
      },
    };
    strategy = new JwtStrategy(prisma, {} as any);
  });

  it('invalidates an existing non-mini token owned by a registered user', async () => {
    await expect(strategy.validate({ sub: 20, mini: false })).rejects.toThrow(
      new ForbiddenException('注册用户无管理后台访问权限'),
    );
  });

  it('continues accepting the registered user mini-program token', async () => {
    await expect(strategy.validate({ sub: 20, mini: true })).resolves.toMatchObject({
      userId: 20,
      userType: UserType.REGISTERED_USER,
      permissions: [],
    });
  });
});
