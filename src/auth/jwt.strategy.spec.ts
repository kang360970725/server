import { UserStatus, UserType } from '@prisma/client';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy registered user compatibility', () => {
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

  it('temporarily accepts an existing token without the mini claim', async () => {
    await expect(strategy.validate({ sub: 20 })).resolves.toMatchObject({
      userId: 20,
      userType: UserType.REGISTERED_USER,
      permissions: [],
    });
  });

  it('continues accepting the registered user mini-program token', async () => {
    await expect(strategy.validate({ sub: 20, mini: true })).resolves.toMatchObject({
      userId: 20,
      userType: UserType.REGISTERED_USER,
      permissions: [],
    });
  });
});
