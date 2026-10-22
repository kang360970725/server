import {BadRequestException} from '@nestjs/common';
import {OrdersService} from './orders.service';

describe('OrdersService member balance supplement transaction', () => {
    const makeService = () => {
        const service = Object.create(OrdersService.prototype) as any;
        service.allocateMemberBalanceLotsTx = jest.fn().mockResolvedValue({untracked: 0});
        service.writeUserLog = jest.fn().mockResolvedValue(undefined);
        return service;
    };

    const makeTx = (availableBalance = 50) => ({
        orderPayment: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({id: 901}),
            update: jest.fn().mockResolvedValue({}),
        },
        memberOrderBalanceReservation: {
            findUnique: jest.fn().mockResolvedValue({
                id: 71,
                orderId: 13407,
                status: 'SUPPLEMENT_PENDING',
                capturedAmount: 100,
                supplementAmount: 20,
            }),
            update: jest.fn().mockResolvedValue({}),
        },
        walletAccount: {
            findUnique: jest.fn().mockResolvedValue({availableBalance}),
            update: jest.fn().mockResolvedValue({availableBalance: availableBalance - 20, frozenBalance: 0}),
        },
        walletTransaction: {create: jest.fn().mockResolvedValue({})},
        order: {update: jest.fn().mockResolvedValue({})},
        $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    });

    it('captures the pending difference and moves the reservation and order to SETTLED', async () => {
        const service = makeService();
        const tx = makeTx();

        const result = await service.payMemberBalanceSupplementTx(
            tx,
            {id: 13407, customerUserId: 88, balanceSettlementMode: 'RESERVE_CAPTURE'},
            9,
            'CONFIRM-13407-12000',
        );

        expect(result).toMatchObject({amount: 20, status: 'SUCCESS', idempotent: false});
        expect(tx.memberOrderBalanceReservation.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({capturedAmount: 120, supplementAmount: 0, status: 'SETTLED'}),
        }));
        expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                paidAmount: 120,
                balanceReservationStatus: 'SETTLED',
                balancePendingSupplementAmount: 0,
            }),
        }));
    });

    it('rejects before creating a payment when the member balance is insufficient', async () => {
        const service = makeService();
        const tx = makeTx(10);

        await expect(service.payMemberBalanceSupplementTx(
            tx,
            {id: 13408, customerUserId: 89, balanceSettlementMode: 'RESERVE_CAPTURE'},
            9,
            'CONFIRM-13408-12000',
        )).rejects.toBeInstanceOf(BadRequestException);
        expect(tx.orderPayment.create).not.toHaveBeenCalled();
        expect(tx.walletAccount.update).not.toHaveBeenCalled();
    });
});

describe('OrdersService member balance legacy reconciliation', () => {
    it('uses wallet balance as authority and auto-creates the missing legacy lot', async () => {
        const service = Object.create(OrdersService.prototype) as any;
        const tx = {
            memberBalanceLot: {
                findMany: jest.fn().mockResolvedValue([
                    {
                        id: 2,
                        principalRemaining: 161.25,
                        bonusRemaining: 150,
                    },
                ]),
                create: jest.fn().mockResolvedValue({
                    id: 99,
                    principalRemaining: 657,
                    bonusRemaining: 0,
                }),
                update: jest.fn().mockResolvedValue({}),
            },
            memberBalanceLotUsage: {
                create: jest.fn().mockResolvedValue({}),
            },
        };

        const result = await service.allocateMemberBalanceLotsTx(tx, {
            userId: 630,
            amount: 500,
            sourceType: 'ORDER_PAYMENT',
            sourceId: 7001,
            walletAvailableBalance: 968.25,
        });

        expect(tx.memberBalanceLot.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 630,
                sourceType: 'LEGACY_RECONCILIATION',
                principalInitial: 657,
                principalRemaining: 657,
            }),
        });
        expect(result).toEqual({allocated: 500, untracked: 0});
    });
});

describe('OrdersService renewal attribution adjustment', () => {
    it('reverses the old bonus, updates attribution and settles the new members', async () => {
        const service = Object.create(OrdersService.prototype) as any;
        service.reverseRenewalBonusesTx = jest.fn().mockResolvedValue({action: 'REVERSED'});
        service.processRenewalAtConfirmTx = jest.fn().mockResolvedValue({action: 'SETTLED'});
        service.buildRenewalBonusEligibilitySnapshotTx = jest.fn().mockResolvedValue({
            eligibleUserIds: [12],
            snapshot: [{userId: 12, eligible: true}],
        });
        const tx = {
            orderRenewalGroup: {
                findUnique: jest.fn().mockResolvedValue({id: 31, status: 'SETTLED'}),
                update: jest.fn().mockResolvedValue({}),
            },
            user: {
                findMany: jest.fn().mockResolvedValue([{id: 12, name: '服务者A', phone: '13800000000'}]),
            },
        };
        const order = {
            id: 13407,
            dispatches: [{participants: [{userId: 12, rejectedAt: null}]}],
        };

        const result = await service.adjustRenewalAttributionTx({
            tx,
            order,
            settlementBatchId: 'batch-1',
            operatorId: 9,
            attributionType: 'RENEWAL',
            memberUserIds: [12],
            reason: '客服核实归因人员有误',
        });

        expect(result).toMatchObject({action: 'ATTRIBUTION_ADJUSTED', memberUserIds: [12]});
        expect(service.reverseRenewalBonusesTx).toHaveBeenCalled();
        expect(tx.orderRenewalGroup.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                groupKey: '12',
                memberUserIds: [12],
                status: 'PENDING',
            }),
        }));
        expect(service.processRenewalAtConfirmTx).toHaveBeenCalledWith(expect.objectContaining({
            settlementBatchId: 'batch-1',
            mode: 'SETTLE',
        }));
    });
});
