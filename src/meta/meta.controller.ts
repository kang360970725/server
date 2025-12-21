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
        };
    }
}
