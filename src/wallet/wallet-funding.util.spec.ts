import { inspectWalletFundingTx } from './wallet-funding.util';

export function fundingFixture() {
  const account = { availableBalance: -700, earningFrozenBalance: 1000, withdrawFrozenBalance: 800, frozenBalance: 1800, depositBalance: 9999 };
  const requests: any[] = [{ id: 1, amount: 800, reserveTx: { userId: 7, sourceId: 1, amount: 800, status: 'FROZEN', direction: 'OUT', bizType: 'WITHDRAW_RESERVE' } }];
  const tx: any = {
    walletAccount: { findUnique: jest.fn(async () => account) },
    walletHold: { aggregate: jest.fn(async () => ({ _sum: { amount: 1000 } })), count: jest.fn(async () => 0) },
    walletWithdrawalRequest: { findMany: jest.fn(async () => requests) },
  };
  return { tx, account, requests };
}
describe('wallet funding coverage', () => {
  it('rejects frozen holds backed by invalid or already released earnings', async () => {
    const { tx } = fundingFixture(); tx.walletHold.count.mockResolvedValue(1);
    await expect(inspectWalletFundingTx(tx, 7, 1)).rejects.toThrow('无效来源流水');
  });
  it('counts earnings but excludes withdrawal reserves and platform deposit', async () => {
    const { tx } = fundingFixture();
    expect((await inspectWalletFundingTx(tx, 7, 1)).spendableAssets).toBe(300);
  });
  it.each([
    { earningFrozenBalance: 1200, frozenBalance: 2000 },
    { withdrawFrozenBalance: 799, frozenBalance: 1799 },
    { frozenBalance: 1801 }, { earningFrozenBalance: -1 },
  ])('blocks corrupt buckets %j', async (values) => {
    const { tx, account } = fundingFixture(); Object.assign(account, values);
    await expect(inspectWalletFundingTx(tx, 7, 1)).rejects.toThrow('冻结余额');
  });
  it.each([
    { userId: 8 }, { amount: 799 }, { sourceId: 9 }, { direction: 'IN' },
    { status: 'AVAILABLE' }, { bizType: 'RENTAL_ORDER_PREPAY' },
  ])('blocks invalid reservation %j', async (values) => {
    const { tx, requests } = fundingFixture(); Object.assign(requests[0].reserveTx, values);
    await expect(inspectWalletFundingTx(tx, 7, 1)).rejects.toThrow('预留流水');
  });
  it('checks all pending reservations, not just the one being paid', async () => {
    const { tx, requests } = fundingFixture(); requests.push({ id: 2, amount: 1, reserveTx: null });
    await expect(inspectWalletFundingTx(tx, 7, 1)).rejects.toThrow('预留流水');
  });
  it('blocks missing request', async () => {
    const { tx } = fundingFixture(); await expect(inspectWalletFundingTx(tx, 7, 2)).rejects.toThrow('有效预留');
  });
});
