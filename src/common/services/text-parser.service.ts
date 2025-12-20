import { Injectable } from '@nestjs/common';

@Injectable()
export class TextParserService {

    /**
     * 解析订单文本，提取陪玩贡献信息
     */
    parseOrderDescription(description: string): { playerName: string; contribution: number; isSupplement: boolean }[] {
        if (!description) return [];

        const results = [];
        const lines = description.split('\n').filter(line => line.trim());

        for (const line of lines) {
            // 匹配模式：玩家名 + 贡献信息
            const match = line.match(/([\u4e00-\u9fa5a-zA-Z0-9]+)\s*([\+\-]?\d+(?:\.\d+)?[wW万]*)/);
            if (match) {
                const playerName = match[1].trim();
                let contribution = this.parseContribution(match[2]);
                const isSupplement = line.includes('补') || line.includes('加保底') || contribution < 0;

                results.push({
                    playerName,
                    contribution,
                    isSupplement
                });
            }
        }

        return results;
    }

    private parseContribution(contributionStr: string): number {
        // 处理 "165w", "488万", "-340w" 等格式
        let amount = contributionStr.replace(/[^\d.\-]/g, '');

        // 如果包含"万"或"w"，乘以10000
        if (contributionStr.toLowerCase().includes('w') || contributionStr.includes('万')) {
            return parseFloat(amount) * 10000;
        }

        return parseFloat(amount) || 0;
    }

    /**
     * 从描述中提取补单数额
     */
    extractSupplementAmount(description: string): number {
        if (!description) return 0;

        const lines = description.split('\n');
        for (const line of lines) {
            // 匹配补单模式
            if (line.includes('加保底') || line.includes('补保底')) {
                const match = line.match(/(\d+)[wW万]/);
                if (match) {
                    return parseInt(match[1]) * 10000;
                }
            }
        }

        return 0;
    }
}
