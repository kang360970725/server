import { UserStatus, UserType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

describe('AuthService login portal isolation', () => {
  let service: AuthService;
  let prisma: any;
  let jwtService: any;
  let registeredUser: any;

  beforeAll(async () => {
    registeredUser = {
      id: 20,
      phone: '13800000020',
      password: await bcrypt.hash('TestPassword123!', 4),
      name: '注册用户',
      userType: UserType.REGISTERED_USER,
      status: UserStatus.ACTIVE,
      Role: null,
    };
  });

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ ...registeredUser }),
        update: jest.fn().mockResolvedValue({ ...registeredUser }),
      },
    };
    jwtService = {
      sign: jest.fn().mockReturnValue('test-token'),
    };
    service = new AuthService(prisma, jwtService, {} as any);
  });

  it('rejects a registered user on the admin login path', async () => {
    const result = await service.login({
      phone: registeredUser.phone,
      password: 'TestPassword123!',
    });

    expect(result).toEqual({
      success: false,
      code: 'ADMIN_LOGIN_FORBIDDEN',
      message: '该账号为注册用户，请通过小程序登录',
    });
    expect(jwtService.sign).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('keeps the mini-program login path available to a registered user', async () => {
    const result = await service.login(
      {
        phone: registeredUser.phone,
        password: 'TestPassword123!',
      },
      { mini: true },
    );

    expect(result).toMatchObject({
      success: true,
      access_token: 'test-token',
      user: {
        id: registeredUser.id,
        userType: UserType.REGISTERED_USER,
      },
    });
    expect(jwtService.sign).toHaveBeenCalledTimes(1);
  });
});
