import { BadRequestException } from '@nestjs/common';

export const ACTIVE_WITHDRAWAL_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'PAYING', 'FAILED'];

const cents = (value: any) => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || !Number.isSafeInteger(Math.round(n * 100))) {
    throw new BadRequestException('钱包金额非法');
  }
  return Math.round(n * 100);
};

/** 调用者必须先持有钱包行锁。拒绝不一致的历史分桶，绝不把提现冻结或平台保证金当可支付资产。 */
export async function inspectWalletFundingTx(tx: any, userId: number, payoutRequestId?: number) {
  const [account, holds, requests, invalidHolds] = await Promise.all([
    tx.walletAccount.findUnique({ where: { userId } }),
    tx.walletHold.aggregate({ where: { userId, status: 'FROZEN' }, _sum: { amount: true } }),
    tx.walletWithdrawalRequest.findMany({
      where: { userId, status: { in: ACTIVE_WITHDRAWAL_STATUSES } },
      include: { reserveTx: true },
    }),
    tx.walletHold.count({ where: { userId, status: 'FROZEN', OR: [
      { amount: { lt: 0 } },
      { earningTx: { is: { OR: [{ userId: { not: userId } }, { status: { not: 'FROZEN' } }, { direction: { not: 'IN' } }] } } },
    ] } }),
  ]);
  if (!account) throw new BadRequestException('钱包账户不存在');
  if (invalidHolds > 0) throw new BadRequestException('收益冻结包含已释放、已冲正或无效来源流水，请先排查修复');
  const available = cents(account.availableBalance);
  const earning = cents(account.earningFrozenBalance);
  const withdraw = cents(account.withdrawFrozenBalance);
  const frozen = cents(account.frozenBalance);
  const expectedEarning = cents(holds?._sum?.amount);
  let expectedWithdraw = 0;
  for (const request of requests) {
    const reserve = request.reserveTx;
    const amount = cents(request.amount);
    if (amount <= 0 || !reserve || reserve.userId !== userId ||
        reserve.bizType !== 'WITHDRAW_RESERVE' || reserve.direction !== 'OUT' ||
        reserve.status !== 'FROZEN' || cents(reserve.amount) !== amount ||
        reserve.sourceId !== request.id || request.payoutTxId) {
      throw new BadRequestException('提现预留流水不完整，请先核对提现资金');
    }
    expectedWithdraw += amount;
  }
  if (earning < 0 || withdraw < 0 || expectedEarning < 0 ||
      earning !== expectedEarning || withdraw !== expectedWithdraw || frozen !== earning + withdraw) {
    throw new BadRequestException('钱包冻结余额与收益流水或在途提现不一致，请先排查修复');
  }
  if (payoutRequestId && !requests.some((r: any) => r.id === payoutRequestId)) {
    throw new BadRequestException('该提现申请不在有效预留资金中');
  }
  return { account, available: available / 100, earningFrozen: earning / 100,
    withdrawFrozen: withdraw / 100, spendableAssets: (available + earning) / 100 };
}
