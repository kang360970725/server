import * as jwt from 'jsonwebtoken';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard refreshed token audience', () => {
  const previousSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'jwt-auth-guard-test-secret';
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  function context(path: string) {
    const response = { setHeader: jest.fn() };
    const request = { route: { path }, originalUrl: path, url: path };
    return {
      response,
      value: {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => response,
        }),
      } as any,
    };
  }

  it('preserves mini=true when refreshing a mini-program request', () => {
    const guard = new JwtAuthGuard({} as any);
    const current = context('/mini/orders');
    guard.handleRequest(null, { id: 20, phone: '13800000020', name: '注册会员' }, null, current.value);

    const token = current.response.setHeader.mock.calls[0][1];
    expect(jwt.verify(token, process.env.JWT_SECRET!)).toMatchObject({ sub: 20, mini: true });
  });

  it('keeps mini=false when refreshing an admin request', () => {
    const guard = new JwtAuthGuard({} as any);
    const current = context('/orders/list');
    guard.handleRequest(null, { id: 20, phone: '13800000020', name: '注册会员' }, null, current.value);

    const token = current.response.setHeader.mock.calls[0][1];
    expect(jwt.verify(token, process.env.JWT_SECRET!)).toMatchObject({ sub: 20, mini: false });
  });
});
