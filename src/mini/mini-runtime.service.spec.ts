import { MiniRuntimeService } from './mini-runtime.service';

describe('MiniRuntimeService', () => {
  const createService = (config: any) => new MiniRuntimeService({
    getMiniappCustomerServiceConfig: jest.fn().mockResolvedValue(config),
  } as any);

  const headers = (version: string, env: string) => ({
    'x-miniapp-appid': 'wx-test',
    'x-miniapp-version': version,
    'x-miniapp-build': `${version}+test`,
    'x-miniapp-env': env,
  });

  it('enables review mode for a configured trial version', async () => {
    const service = createService({ wechatReviewMode: true, wechatReviewVersions: ['1.0.1'], revision: 7 });
    const result = await service.resolve(headers('1.0.1', 'trial'));
    expect(result.mode).toBe('REVIEW');
    expect(result.revision).toBe(7);
    expect(result.features.wallet).toBe(false);
    expect(result.features.memberCenter).toBe(true);
  });

  it('keeps release builds in normal mode', async () => {
    const service = createService({ wechatReviewMode: true, wechatReviewVersions: ['1.0.1'], revision: 8 });
    const result = await service.resolve(headers('1.0.1', 'release'));
    expect(result.mode).toBe('NORMAL');
    expect(result.features.wallet).toBe(true);
  });

  it('does not enable review mode for a different version', async () => {
    const service = createService({ wechatReviewMode: true, wechatReviewVersions: ['1.0.2'], revision: 9 });
    const result = await service.resolve(headers('1.0.1', 'trial'));
    expect(result.mode).toBe('NORMAL');
  });

  it('accepts a v-prefixed configured version', async () => {
    const service = createService({ wechatReviewMode: true, wechatReviewVersions: ['v1.0.1'], revision: 10 });
    const result = await service.resolve(headers('1.0.1', 'develop'));
    expect(result.mode).toBe('REVIEW');
  });
});
