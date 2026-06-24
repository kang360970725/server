export const walletAccountBalanceSelect = {
  id: true,
  userId: true,
  walletUid: true,
  availableBalance: true,
  frozenBalance: true,
  earningFrozenBalance: true,
  withdrawFrozenBalance: true,
  depositBalance: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type WalletAccountBalanceShape = {
  id?: number;
  userId?: number;
  walletUid?: string | null;
  availableBalance?: any;
  frozenBalance?: any;
  earningFrozenBalance?: any;
  withdrawFrozenBalance?: any;
  depositBalance?: any;
  createdAt?: Date;
  updatedAt?: Date;
};

export function round2Amount(value: any): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function normalizeWalletAccountBuckets(account?: WalletAccountBalanceShape | null) {
  const availableBalance = round2Amount(account?.availableBalance);
  const frozenBalance = round2Amount(account?.frozenBalance);
  const earningFrozenBalance = round2Amount(account?.earningFrozenBalance);
  const withdrawFrozenBalance = round2Amount(account?.withdrawFrozenBalance);
  const depositBalance = round2Amount(account?.depositBalance);
  const bucketFrozenBalance = round2Amount(earningFrozenBalance + withdrawFrozenBalance);

  return {
    availableBalance,
    frozenBalance,
    earningFrozenBalance,
    withdrawFrozenBalance,
    bucketFrozenBalance,
    depositBalance,
    totalBalance: round2Amount(availableBalance + frozenBalance),
  };
}

function toDeltaOperation(delta: number) {
  const amount = round2Amount(Math.abs(delta));
  if (!amount) return undefined;
  return delta >= 0 ? { increment: amount } : { decrement: amount };
}

export function buildWalletAccountDeltaData(input: {
  availableDelta?: number;
  earningFrozenDelta?: number;
  withdrawFrozenDelta?: number;
  depositDelta?: number;
}) {
  const availableDelta = round2Amount(input.availableDelta);
  const earningFrozenDelta = round2Amount(input.earningFrozenDelta);
  const withdrawFrozenDelta = round2Amount(input.withdrawFrozenDelta);
  const depositDelta = round2Amount(input.depositDelta);
  const totalFrozenDelta = round2Amount(earningFrozenDelta + withdrawFrozenDelta);

  const data: any = {};
  const availableOp = toDeltaOperation(availableDelta);
  const earningFrozenOp = toDeltaOperation(earningFrozenDelta);
  const withdrawFrozenOp = toDeltaOperation(withdrawFrozenDelta);
  const frozenOp = toDeltaOperation(totalFrozenDelta);
  const depositOp = toDeltaOperation(depositDelta);

  if (availableOp) data.availableBalance = availableOp;
  if (earningFrozenOp) data.earningFrozenBalance = earningFrozenOp;
  if (withdrawFrozenOp) data.withdrawFrozenBalance = withdrawFrozenOp;
  if (frozenOp) data.frozenBalance = frozenOp;
  if (depositOp) data.depositBalance = depositOp;

  return data;
}

export function buildWalletAccountSetData(input: {
  availableBalance: number;
  earningFrozenBalance: number;
  withdrawFrozenBalance: number;
  depositBalance?: number;
}) {
  const availableBalance = round2Amount(input.availableBalance);
  const earningFrozenBalance = round2Amount(input.earningFrozenBalance);
  const withdrawFrozenBalance = round2Amount(input.withdrawFrozenBalance);
  const frozenBalance = round2Amount(earningFrozenBalance + withdrawFrozenBalance);

  const data: any = {
    availableBalance,
    earningFrozenBalance,
    withdrawFrozenBalance,
    frozenBalance,
  };

  if (input.depositBalance !== undefined) {
    data.depositBalance = round2Amount(input.depositBalance);
  }

  return data;
}
