/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';

/**
 * 回填脚本：为所有缺少 WalletAccount 的用户创建钱包账户
 *
 * 使用方式（在项目根目录）：
 * 1) npx ts-node scripts/backfill-wallet-accounts.ts
 *
 * 注意：
 * - 这是幂等脚本：重复跑不会重复创建（基于 userId unique）
 * - 建议先在测试库跑一遍确认
 */
async function main() {
    const prisma = new PrismaClient();
    try {
        const usersWithoutWallet = await prisma.user.findMany({
            where: {
                walletAccount: null,
            },
            select: { id: true, phone: true },
            take: 100000, // 保守上限，避免误伤
        });

        console.log(`Found ${usersWithoutWallet.length} users without walletAccount`);

        let created = 0;
        for (const u of usersWithoutWallet) {
            await prisma.walletAccount.create({
                data: { userId: u.id },
            });
            created++;
            if (created % 200 === 0) console.log(`Created ${created} wallet accounts...`);
        }

        console.log(`Done. Created ${created} wallet accounts.`);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
