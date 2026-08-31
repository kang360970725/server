import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { inspectWalletFundingTx } from '../wallet/wallet-funding.util';
import { CreateAdminRentalOrderDto, SettleAdminRentalOrderDto } from './dto/admin-rental-order.dto';
import { dateOnly, money, settleAmounts, shanghaiDay, startDateFor, textField, todayRange } from './rental-order.rules';

class RentalSerialCollision extends Error {}

@Injectable()
export class RentalOrdersService {
  constructor(private readonly prisma: PrismaService, private readonly wallet: WalletService) {}

  private generateSerialNo() {
    return `LMSH${randomInt(10000000, 100000000)}`;
  }

  private id(value: any) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequestException('ID无效');
    return id;
  }
  private async lockWallet(tx: any, userId: number) {
    await tx.$queryRawUnsafe('SELECT userId FROM wallet_accounts WHERE userId = ? FOR UPDATE', userId);
  }
  private async lockOrder(tx: any, id: number) {
    await tx.$queryRawUnsafe('SELECT id FROM rental_orders WHERE id = ? FOR UPDATE', id);
    const order = await tx.rentalOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('租号订单不存在');
    return order;
  }
  private checkVersion(order: any, version: any) {
    if (!Number.isInteger(version) || version !== order.version) throw new ConflictException('订单已更新，请刷新后重试');
  }
  private async log(tx: any, operatorId: number, order: any, action: string) {
    await tx.userLog.create({ data: {
      userId: operatorId, action, targetType: 'RENTAL_ORDER', targetId: order.id,
      newData: JSON.parse(JSON.stringify(order)), remark: `租号订单 ${order.serialNo}`,
    } });
  }
  private async post(tx: any, order: any, amount: number, bizType: string, direction: 'IN' | 'OUT', remark: string) {
    if (amount === 0) return;
    const after = await this.wallet.applyWalletAccountDelta(tx, order.staffUserId, {
      availableDelta: direction === 'IN' ? amount : -amount,
    });
    await tx.walletTransaction.create({ data: {
      userId: order.staffUserId, direction, bizType, amount, status: 'AVAILABLE',
      sourceType: bizType, sourceId: order.id,
      availableAfter: after.availableBalance, frozenAfter: after.frozenBalance,
      remark: `${order.serialNo} ${remark}`,
    } });
  }

  async create(input: CreateAdminRentalOrderDto, operatorId: number) {
    const userId = this.id(input.staffUserId);
    const prepaidAmount = money(input.prepaidAmount, '预扣租金', true);
    const depositAmount = money(input.depositAmount ?? 0, '租号押金');
    const accountSourceNo = textField(input.accountSourceNo, '号源编号', true, 100);
    const forcedSettlementDate = dateOnly(input.forcedSettlementDate, '强制结算日期');
    // 唯一索引最终排重；只对订单编号碰撞重试整个事务，不重试资金流水冲突。
    for (let attempt = 0; attempt < 5; attempt++) {
      const serialNo = this.generateSerialNo();
      try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockWallet(tx, userId);
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user || user.userType !== 'STAFF' || user.status === 'DISABLED' ||
            !['ACTIVE', 'FROZEN'].includes(String(user.staffEmploymentStatus))) {
          throw new BadRequestException('仅支持正常或冻结中的服务者，退店或限制服务账号不能创建租号订单');
        }
        await this.wallet.ensureWalletAccountBucketsReady(userId, tx as any);
        const funding = await inspectWalletFundingTx(tx, userId);
        if (Math.round(funding.spendableAssets * 100) < Math.round(prepaidAmount * 100) + Math.round(depositAmount * 100)) {
          throw new BadRequestException('租号可用资产不足（仅计可用余额与收益冻结，不含提现冻结、平台保证金）');
        }
        const now = new Date();
        const startDate = startDateFor(now);
        if (forcedSettlementDate < startDate) throw new BadRequestException('强制结算日期不能早于开始日期');
        const order = await tx.rentalOrder.create({ data: {
          serialNo, staffUserId: userId, staffNameSnapshot: user.name || String(userId),
          accountSourceId: null, accountSourceNo, sourceChannel: 'ADMIN', prepaidAmount, depositAmount,
          startDate, forcedSettlementDate, createdBy: operatorId, createdAt: now,
        } }).catch((error) => {
          if (error?.code === 'P2002') throw new RentalSerialCollision();
          throw error;
        });
        await this.post(tx, order, prepaidAmount, 'RENTAL_ORDER_PREPAY', 'OUT', '预扣租金');
        await this.post(tx, order, depositAmount, 'RENTAL_ORDER_DEPOSIT', 'OUT', '租号押金（绑定本单）');
        await this.log(tx, operatorId, order, 'RENTAL_ORDER_CREATE');
        return order;
      });
      } catch (error: any) {
        if (!(error instanceof RentalSerialCollision)) throw error;
      }
    }
    throw new ConflictException('租号流水编号生成繁忙，请稍后重试');
  }

  async settle(id: number, input: SettleAdminRentalOrderDto, operatorId: number) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, this.id(id));
      if (order.status === 'SETTLED') return order; // 重试不重复退款/补扣。
      if (order.status !== 'RUNNING') throw new BadRequestException('仅进行中的租号订单可以结算');
      this.checkVersion(order, input.version);
      const amounts = settleAmounts(order, input);
      await this.lockWallet(tx, order.staffUserId);
      const refund = amounts.settlementNetRefund;
      await this.post(tx, order, Math.abs(refund), refund >= 0 ? 'RENTAL_ORDER_REFUND' : 'RENTAL_ORDER_EXCESS_CHARGE',
        refund >= 0 ? 'IN' : 'OUT', refund >= 0 ? '结算退回（押金及退差抵扣损耗/赔付后的余额）' : '租号费用溢出补差');
      const updated = await tx.rentalOrder.update({ where: { id: order.id }, data: {
        ...amounts, status: 'SETTLED', settledBy: operatorId, settledAt: new Date(), version: { increment: 1 },
        calculationSnapshot: { version: 1, prepaidAmount: Number(order.prepaidAmount), depositAmount: Number(order.depositAmount),
          ...amounts, formula: '净退款=租号押金+租金退差-损耗-异常赔付' },
      } });
      await this.log(tx, operatorId, updated, 'RENTAL_ORDER_SETTLE');
      return updated;
    });
  }

  async void(id: number, input: { version: number; reason: string }, operatorId: number) {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, this.id(id));
      if (order.status === 'VOIDED') return order;
      if (order.status !== 'RUNNING') throw new BadRequestException('仅进行中的租号订单可以废除');
      this.checkVersion(order, input.version);
      const now = new Date();
      if (now.getTime() - order.createdAt.getTime() > 2 * 3600000) throw new BadRequestException('订单创建已超过2小时，不能废除');
      const reason = textField(input.reason, '废除原因', true);
      await this.lockWallet(tx, order.staffUserId);
      const amount = (Math.round(Number(order.prepaidAmount) * 100) + Math.round(Number(order.depositAmount) * 100)) / 100;
      await this.post(tx, order, amount, 'RENTAL_ORDER_VOID_REFUND', 'IN', `废除返还租金及押金：${reason}`);
      const updated = await tx.rentalOrder.update({ where: { id: order.id }, data: {
        status: 'VOIDED', voidedAt: now, voidedBy: operatorId, voidReason: reason, version: { increment: 1 },
      } });
      await this.log(tx, operatorId, updated, 'RENTAL_ORDER_VOID');
      return updated;
    });
  }

  async detail(id: number) {
    const order = await this.prisma.rentalOrder.findUnique({ where: { id: this.id(id) } });
    if (!order) throw new NotFoundException('租号订单不存在');
    const transactions = await this.prisma.walletTransaction.findMany({ where: {
      sourceId: order.id, sourceType: { in: ['RENTAL_ORDER_PREPAY', 'RENTAL_ORDER_DEPOSIT', 'RENTAL_ORDER_REFUND',
        'RENTAL_ORDER_EXCESS_CHARGE', 'RENTAL_ORDER_VOID_REFUND'] },
    }, orderBy: { id: 'asc' } });
    const operatorIds = [...new Set([order.createdBy, order.settledBy, order.voidedBy].filter((id): id is number => id != null))];
    const operators = await this.prisma.user.findMany({ where: { id: { in: operatorIds } }, select: { id: true, name: true } });
    const names = new Map(operators.map((user) => [user.id, user.name]));
    const operatorName = (id: number | null) => id == null ? null : (names.get(id) || '未知操作人');
    return { ...order, transactions, createdByName: operatorName(order.createdBy),
      settledByName: operatorName(order.settledBy), voidedByName: operatorName(order.voidedBy) };
  }
  async list(query: any) {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 20)));
    const where: any = {};
    if (query.status) {
      if (!['RUNNING', 'SETTLED', 'VOIDED'].includes(query.status)) throw new BadRequestException('订单状态无效');
      where.status = query.status;
    }
    if (query.staffUserId) where.staffUserId = this.id(query.staffUserId);
    if (query.search) {
      const search = textField(query.search, '查询内容', false, 100);
      where.OR = [{ serialNo: { contains: search } }, { accountSourceNo: { contains: search } }, { staffNameSnapshot: { contains: search } }];
    }
    if (query.overdue === 'true') {
      where.status = 'RUNNING';
      where.forcedSettlementDate = { lt: dateOnly(shanghaiDay(), '今日') };
    }
    return this.prisma.$transaction(async (tx) => {
      const [list, total, created, settled] = await Promise.all([
        tx.rentalOrder.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { id: 'desc' } }),
        tx.rentalOrder.count({ where }),
        tx.rentalOrder.aggregate({ where: { createdAt: todayRange(), status: { not: 'VOIDED' } }, _count: true, _sum: { prepaidAmount: true, depositAmount: true } }),
        tx.rentalOrder.aggregate({ where: { settledAt: todayRange(), status: 'SETTLED' }, _count: true, _sum: { actualAmount: true, ownerSettlementAmount: true } }),
      ]);
      return { list, total, page, limit, serverNow: new Date().toISOString(), stats: {
        date: shanghaiDay(), createdCount: created._count, rentalAmount: Number(created._sum.prepaidAmount || 0),
        depositAmount: Number(created._sum.depositAmount || 0), settledCount: settled._count,
        staffSettlementAmount: Number(settled._sum.actualAmount || 0), ownerSettlementAmount: Number(settled._sum.ownerSettlementAmount || 0),
      } };
    });
  }
}
