import { OrdersService } from './orders.service';

describe('hourly order settlement basis after supplementary collection', () => {
    it.each([
        { settlementBaseMode: 'PAID_AMOUNT' as const, expected: 160 },
        { settlementBaseAmount: 140, expected: 140 },
        { settlementBaseMode: 'SETTLEMENT_BASE_AMOUNT' as const, expected: 100 },
        { settlementBaseAmount: 161, expected: null },
    ])('uses the same selected basis for preview, payout validation and persistence', async ({ expected, ...basis }) => {
        const order = {
            id: 7, status: 'COMPLETED', paidAmount: 160, settlementBaseAmount: 100,
            projectSnapshot: { billingMode: 'HOURLY' }, dispatches: [], settlements: [], refunds: [],
        };
        const update = jest.fn();
        const tx = { $queryRawUnsafe: jest.fn(), order: { update } };
        const service = Object.assign(Object.create(OrdersService.prototype), {
            prisma: { $transaction: (callback: (client: typeof tx) => unknown) => callback(tx) },
            settlementRepairCache: new Map(),
            assertOrderNotSettlingOrThrow: jest.fn(),
            loadOrderForSettlementTx: jest.fn().mockResolvedValue(order),
            buildSettlementPlanFromOrder: jest.fn().mockResolvedValue({ billingMode: 'HOURLY', settlementsToCreate: [{}] }),
            applySettlementPlanTx: jest.fn().mockResolvedValue({}),
            afterSettlementAppliedTx: jest.fn(),
        });
        if (expected === null) {
            await expect(service.repairWalletForOrderSettlementsV2({ orderId: 7, operatorId: 1, dryRun: true, ...basis }))
                .rejects.toThrow('手动结算金额不能超过');
            expect(update).not.toHaveBeenCalled();
            expect(service.applySettlementPlanTx).not.toHaveBeenCalled();
            return;
        }
        await service.repairWalletForOrderSettlementsV2({ orderId: 7, operatorId: 1, dryRun: true, ...basis });
        expect(update).not.toHaveBeenCalled();

        await service.repairWalletForOrderSettlementsV2({ orderId: 7, operatorId: 1, applyRepair: true, ...basis });
        if (expected === 100) expect(update).not.toHaveBeenCalled();
        else expect(update).toHaveBeenCalledWith({ where: { id: 7 }, data: { settlementBaseAmount: expected } });
        expect(service.applySettlementPlanTx).toHaveBeenCalledWith(expect.objectContaining({
            order: expect.objectContaining({ settlementBaseAmount: expected }),
        }));
    });
});

describe('confirming a supplemented non-member hourly order', () => {
    it.each([
        ['PAID_AMOUNT', 160],
        ['SETTLEMENT_BASE_AMOUNT', 100],
    ])('completes with %s as the settlement basis', async (mode, expected) => {
        const order = {
            id: 7, status: 'COMPLETED_PENDING_CONFIRM', paidAmount: 100, settlementBaseAmount: 100,
            isPaid: true, customerUserId: null, projectSnapshot: { billingMode: 'HOURLY' },
        };
        const tx = { order: { update: jest.fn() } };
        const service = Object.assign(Object.create(OrdersService.prototype), {
            prisma: {
                $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
                order: { findUnique: jest.fn().mockResolvedValue(null) },
            },
            lockOrderForSettlement: jest.fn(),
            assertOrderNotSettlingOrThrow: jest.fn(),
            loadOrderForSettlementTx: jest.fn().mockResolvedValue(order),
            applyPaidAmountUpdateInTx: jest.fn(() => { order.paidAmount = 160; }),
            buildSettlementPlanFromOrder: jest.fn().mockResolvedValue({ settlementsToCreate: [{}], evaluationRows: [] }),
            applySettlementPlanTx: jest.fn().mockResolvedValue({}),
            processRenewalAtConfirmTx: jest.fn(),
            afterSettlementAppliedTx: jest.fn(),
            applyOrderMemberBenefitsTx: jest.fn(),
        });
        await expect(service.confirmCompleteOrder(7, 1, { paidAmount: 160, settlementBaseMode: mode }))
            .resolves.toMatchObject({ status: 'COMPLETED' });
        expect(service.applyPaidAmountUpdateInTx).toHaveBeenCalled();
        expect(service.applySettlementPlanTx).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'FINAL_CONFIRM',
            order: expect.objectContaining({ paidAmount: 160, settlementBaseAmount: expected }),
        }));
    });
});
