import { UserStatus, UserType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

describe('AuthService registered user login compatibility', () => {
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

  it('temporarily keeps the admin login path available to a registered user', async () => {
    const result = await service.login({
      phone: registeredUser.phone,
      password: 'TestPassword123!',
    });

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
