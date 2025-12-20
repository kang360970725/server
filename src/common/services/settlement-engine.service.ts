import { Injectable } from '@nestjs/common';

@Injectable()
export class SettlementEngineService {

    /**
     * 计算陪玩分润
     */
    calculatePlayerEarnings(params: {
        orderAmount: number;
        baseAmount: number;
        clubRate: number | null;
        playerContributions: { userId: number; contribution: number; ratingRate: number; isSupplement?: boolean }[];
        supplementAmount?: number;
        orderType: string;
    }) {
        const { orderAmount, baseAmount, clubRate, playerContributions, supplementAmount = 0, orderType } = params;

        // 1. 计算俱乐部抽成
        let clubEarnings = 0;
        let remainingAmount = orderAmount;

        if (clubRate !== null && clubRate !== undefined) {
            clubEarnings = orderAmount * clubRate;
            remainingAmount = orderAmount - clubEarnings;
        }

        // 2. 分离主力陪玩和补单陪玩
        const mainPlayers = playerContributions.filter(p => !p.isSupplement);
        const supplementPlayers = playerContributions.filter(p => p.isSupplement);

        // 3. 计算补单负收益
        let supplementEarningsMap = new Map();
        if (supplementAmount > 0 && baseAmount > 0 && supplementPlayers.length > 0) {
            const supplementEarningPerPlayer = (supplementAmount / (baseAmount / orderAmount)) / supplementPlayers.length;
            supplementPlayers.forEach(player => {
                supplementEarningsMap.set(player.userId, -Math.abs(supplementEarningPerPlayer));
            });
        }

        // 4. 计算基础分润（重新分配补单金额）
        const totalDistributionAmount = remainingAmount + Math.abs(supplementAmount);
        const baseEarningsMap = new Map();

        if (mainPlayers.length > 0) {
            // 按评级比例分配
            const totalRatingRate = mainPlayers.reduce((sum, p) => sum + p.ratingRate, 0);
            mainPlayers.forEach(player => {
                const ratio = player.ratingRate / totalRatingRate;
                baseEarningsMap.set(player.userId, totalDistributionAmount * ratio);
            });
        }

        // 5. 合并收益
        const finalEarnings = playerContributions.map(player => {
            const baseEarning = baseEarningsMap.get(player.userId) || 0;
            const supplementEarning = supplementEarningsMap.get(player.userId) || 0;
            const finalEarning = baseEarning + supplementEarning;

            return {
                userId: player.userId,
                baseEarnings: player.isSupplement ? 0 : baseEarning, // 补单陪玩没有基础收益
                supplementEarnings: supplementEarning,
                finalEarnings: finalEarning,
                isSupplement: player.isSupplement || false
            };
        });

        return {
            clubEarnings,
            playerEarnings: finalEarnings,
            splitMode: clubRate !== null && clubRate !== undefined ? 'FIXED' : 'RATING_BASED',
            totalDistribution: totalDistributionAmount
        };
    }

    private calculateSupplementEarnings(
        supplementAmount: number,
        baseAmount: number,
        orderAmount: number,
        players: { userId: number; contribution: number }[]
    ): number[] {
        if (!supplementAmount || !baseAmount) return new Array(players.length).fill(0);

        // 补单收益 = 补币量 / (订单保底量 / 订单金额) / 参与人数
        const supplementEarningPerPlayer = (supplementAmount / (baseAmount / orderAmount)) / players.length;

        return players.map(player => {
            // 如果是补单且贡献为负，给予负收益
            if (player.contribution < 0) {
                return -Math.abs(supplementEarningPerPlayer);
            }
            return supplementEarningPerPlayer;
        });
    }

    /**
     * 验证总收益不超过订单金额
     */
    validateTotalEarnings(clubEarnings: number, playerEarnings: number[], orderAmount: number): boolean {
        const totalPlayerEarnings = playerEarnings.reduce((sum, earning) => sum + earning, 0);
        const totalEarnings = clubEarnings + totalPlayerEarnings;

        // 允许轻微误差
        return totalEarnings <= orderAmount * 1.01;
    }

    /**
     * 获取订单类型的默认分润规则
     */
    getDefaultSplitRule(orderType: string): { clubRate: number | null; description: string } {
        const rules = {
            EXPERIENCE: { clubRate: 0.1, description: '体验单固定10%抽成' },
            FUN: { clubRate: null, description: '趣味玩法单按评级分成' },
            ESCORT: { clubRate: null, description: '护航单按评级分成' },
            LUCKY_BAG: { clubRate: null, description: '福袋单按评级分成' },
            BLIND_BOX: { clubRate: 0, description: '盲盒单0抽成' },
            CUSTOM: { clubRate: null, description: '定制单按评级分成' },
            CUSTOMIZED: { clubRate: null, description: '自定义单按评级分成' },
        };

        return rules[orderType] || { clubRate: null, description: '按评级分成' };
    }
}
