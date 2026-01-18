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
            // =========================
            // ✅ 日志 Action 明文字典（新增）
            // =========================
            Action: {
                // -------- 订单域 --------
                ORDER_CREATE: '创建订单',
                ORDER_UPDATE: '修改订单',
                ORDER_ASSIGN: '派单',
                ORDER_UPDATE_PARTICIPANTS: '更新参与者',
                ORDER_REPLACE_PLAYER: '替换打手',
                ORDER_ACCEPT: '接单',
                ORDER_REJECT: '拒单',
                ORDER_ARCHIVE: '存单',
                ORDER_COMPLETE: '结单',
                ORDER_CANCEL: '取消订单',
                ORDER_REFUND: '订单退款',

                PAID_AMOUNT_UPDATE: '修改实付金额',
                ORDER_MARK_PAID: '标记已付款',

                // -------- 派单 / 参与者 --------
                DISPATCH_CREATE: '创建派单批次',
                DISPATCH_UPDATE: '更新派单',
                DISPATCH_CANCEL: '取消派单',

                PARTICIPANT_ACCEPT: '参与者接单',
                PARTICIPANT_REJECT: '参与者拒单',
                PARTICIPANT_REPLACED: '参与者被替换',

                // -------- 结算域 --------
                SETTLEMENT_CREATE: '生成结算记录',
                SETTLEMENT_LOCK: '锁定结算',
                SETTLEMENT_UNLOCK: '解锁结算',
                SETTLEMENT_COMPLETE: '完成结算',

                // -------- 钱包域 --------
                WALLET_CREDIT: '钱包入账',
                WALLET_DEBIT: '钱包扣减',
                WALLET_FREEZE: '钱包冻结',
                WALLET_UNFREEZE: '钱包解冻',
                WALLET_ADJUST: '人工调整钱包余额',

                // -------- 提现域 --------
                WITHDRAW_APPLY: '发起提现申请',
                WITHDRAW_APPROVE: '审核通过提现',
                WITHDRAW_REJECT: '驳回提现申请',
                WITHDRAW_PAYOUT: '提现打款',
                WITHDRAW_FAIL: '提现打款失败',

                // =========================
                // ✅ DB 已存在的 action（必须覆盖）
                // =========================

                // ---- 派单/接单 ----
                ACCEPT_DISPATCH: '接单',
                REJECT_DISPATCH: '拒单',
                ASSIGN_DISPATCH: '派单',
                UPDATE_DISPATCH_PARTICIPANTS: '更新参与者',
                ARCHIVE_DISPATCH: '存单',
                COMPLETE_DISPATCH: '结单（派单完成）',

                // ---- 订单 ----
                CREATE_ORDER: '创建订单',
                UPDATE_ORDER: '修改订单',
                REFUND_ORDER: '订单退款',

                // ---- 收款 ----
                MARK_PAID: '标记已付款',
                UPDATE_PAID_AMOUNT: '修改实付金额',

                // ---- 结算 ----
                SETTLE_ARCHIVE: '存单结算',
                SETTLE_COMPLETE: '结单结算',

                // ---- 账户/人员 ----
                CREATE_USER: '创建用户',
                UPDATE_USER: '修改用户',
                RESET_PASSWORD: '重置密码',

                // --- 财务核账 ---
                FINANCE_RECONCILE_SUMMARY: '财务核账-总览统计查询',
                FINANCE_RECONCILE_ORDERS: '财务核账-订单明细查询',
                FINANCE_RECONCILE_ORDER_DETAIL: '财务核账-订单抽查详情',
            },
        };
    }
}
