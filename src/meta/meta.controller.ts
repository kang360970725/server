import { Controller, Post } from '@nestjs/common';

// 这里把你 prisma enum 统一在后端映射成“可展示字典”
@Controller('meta')
export class MetaController {
    @Post('enums')
    enums() {
        return {
            OrderStatus: {
                WAIT_ASSIGN: '待派单',
                WAIT_ACCEPT: '待接单',
                ACCEPTED: '已接单',
                ARCHIVED: '已存单',
                COMPLETED: '已结单',
                CANCELLED: '已取消',
                // 你后面扩展：待评价/已评价/售后/退款…继续加
            },
            DispatchStatus: {
                WAIT_ASSIGN: '待派单',
                WAIT_ACCEPT: '待接单',
                ACCEPTED: '已接单',
                ARCHIVED: '已存单',
                COMPLETED: '已结单',
            },
            PlayerWorkStatus: {
                IDLE: '空闲',
                WORKING: '接单中',
                RESTING: '休息',
            },
            OrderType: {
                EXPERIENCE: '体验单',
                FUN: '趣味玩法',
                ESCORT: '护航',
                LUCKY_BAG: '福袋',
                BLIND_BOX: '盲盒',
                CUSTOM: '定制',
                CUSTOMIZED: '自定义',
            },
            BillingMode: {
                HOURLY: '小时单',
                GUARANTEED: '保底单',
            },
            WalletDirection: {
                IN: '收入',
                OUT: '支出',
            },
            WalletTxStatus: {
                FROZEN: '冻结中',
                AVAILABLE: '可用',
                REVERSED: '已冲正',
                CANCELLED: '已取消',
            },
            WalletBizType: {
                SETTLEMENT_EARNING: '结算收益（旧）',

                SETTLEMENT_EARNING_BASE: '基础结算收益',
                SETTLEMENT_EARNING_CARRY: '补单收益（炸单补偿）',
                SETTLEMENT_BOMB_LOSS: '炸单损耗（成本扣减）',
                SETTLEMENT_EARNING_CS: '客服分红',

                RELEASE_FROZEN: '解冻入账',
                REFUND_REVERSAL: '退款冲正',

                WITHDRAW_RESERVE: '提现预扣',
                WITHDRAW_RELEASE: '提现退回',
                WITHDRAW_PAYOUT: '提现出款',
            },
        };
    }
}
