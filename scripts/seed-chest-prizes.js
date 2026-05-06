const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const ACTIVITY_KEY = 'treasure_box_demo';

const PRIZES = [
  {
    name: 'iPhone17 Pro Max',
    type: 'PHYSICAL',
    quantity: 1,
    weight: 1,
    stock: 1,
    sortOrder: 10,
    minDrawCount: 0,
    blockBeforeDays: 30,
    rampEveryDays: 7,
    rampStep: 1,
    rampMaxExtra: 20,
    dynamicMode: null,
    publicRuleText: '奖励池包含常驻奖励与阶段奖励，阶段奖励将在满足条件后加入抽取范围；资格条件与参与区间将依据活动节奏动态更新，详细请关注活动说明。该活动一切解释权归蓝猫爽打所有。',
  },
  {
    name: 'iPhone17',
    type: 'PHYSICAL',
    quantity: 1,
    weight: 1,
    stock: 1,
    sortOrder: 20,
    minDrawCount: 0,
    blockBeforeDays: 30,
    rampEveryDays: 7,
    rampStep: 1,
    rampMaxExtra: 20,
    dynamicMode: null,
    publicRuleText: '奖励池包含常驻奖励与阶段奖励，阶段奖励将在满足条件后加入抽取范围；资格条件与参与区间将依据活动节奏动态更新，详细请关注活动说明。该活动一切解释权归蓝猫爽打所有。',
  },
  {
    name: '2000元储值现金券',
    type: 'VOUCHER',
    quantity: 3,
    weight: 10,
    stock: 3,
    sortOrder: 30,
    minDrawCount: 0,
    blockBeforeDays: 30,
    rampEveryDays: 7,
    rampStep: 1,
    rampMaxExtra: 20,
    dynamicMode: null,
    publicRuleText: '奖励池包含常驻奖励与阶段奖励，阶段奖励将在满足条件后加入抽取范围；资格条件与参与区间将依据活动节奏动态更新，详细请关注活动说明。该活动一切解释权归蓝猫爽打所有。',
  },
  {
    name: '1000元储值现金',
    type: 'VOUCHER',
    quantity: 6,
    weight: 10,
    stock: 6,
    sortOrder: 40,
    minDrawCount: 0,
    blockBeforeDays: 30,
    rampEveryDays: 7,
    rampStep: 1,
    rampMaxExtra: 20,
    dynamicMode: null,
    publicRuleText: '奖励池包含常驻奖励与阶段奖励，阶段奖励将在满足条件后加入抽取范围；资格条件与参与区间将依据活动节奏动态更新，详细请关注活动说明。该活动一切解释权归蓝猫爽打所有。',
  },
  {
    name: '坠星者刀皮',
    type: 'GAME_ITEM',
    quantity: 6,
    weight: 10,
    stock: 6,
    sortOrder: 50,
    minDrawCount: 51,
    blockBeforeDays: null,
    rampEveryDays: null,
    rampStep: null,
    rampMaxExtra: null,
    dynamicMode: null,
    publicRuleText: '需累计抽奖>50次',
  },
  {
    name: '三角洲烽火通行证',
    type: 'GAME_ITEM',
    quantity: 20,
    weight: 100,
    stock: 20,
    sortOrder: 60,
    minDrawCount: 51,
    blockBeforeDays: null,
    rampEveryDays: null,
    rampStep: null,
    rampMaxExtra: null,
    dynamicMode: null,
    publicRuleText: '需累计抽奖>50次',
  },
  {
    name: '218体验单',
    type: 'DEDUCT_COUPON',
    quantity: 10,
    weight: 100,
    stock: 10,
    sortOrder: 70,
    minDrawCount: 51,
    blockBeforeDays: null,
    rampEveryDays: null,
    rampStep: null,
    rampMaxExtra: null,
    dynamicMode: null,
    publicRuleText: '需累计抽奖>50次',
  },
  {
    name: '128体验单',
    type: 'DEDUCT_COUPON',
    quantity: 20,
    weight: 100,
    stock: 20,
    sortOrder: 80,
    minDrawCount: 11,
    blockBeforeDays: null,
    rampEveryDays: null,
    rampStep: null,
    rampMaxExtra: null,
    dynamicMode: null,
    publicRuleText: '需累计抽奖>10次',
  },
  {
    name: '20元优惠券',
    type: 'COUPON',
    quantity: 300,
    weight: 120000,
    stock: 300,
    sortOrder: 90,
    minDrawCount: 0,
    blockBeforeDays: null,
    rampEveryDays: null,
    rampStep: null,
    rampMaxExtra: null,
    dynamicMode: null,
    publicRuleText: '常规奖池高概率奖项',
  },
  {
    name: '5元优惠券',
    type: 'COUPON',
    quantity: 500,
    weight: 180000,
    stock: 500,
    sortOrder: 100,
    minDrawCount: 0,
    blockBeforeDays: null,
    rampEveryDays: null,
    rampStep: null,
    rampMaxExtra: null,
    dynamicMode: null,
    publicRuleText: '常规奖池高概率奖项',
  },
  {
    name: '随机保底赠送',
    type: 'DEDUCT_COUPON',
    quantity: 1,
    weight: 699668,
    stock: null,
    sortOrder: 110,
    minDrawCount: 0,
    blockBeforeDays: null,
    rampEveryDays: null,
    rampStep: null,
    rampMaxExtra: null,
    dynamicMode: 'WAN_50_500_PEAK_100_200',
    publicRuleText: '随机50-500万，高概率100-200万',
  },
];

async function main() {
  const cfg = await prisma.chestActivityConfig.upsert({
    where: { activityKey: ACTIVITY_KEY },
    update: {
      launchAt: new Date(),
    },
    create: {
      activityKey: ACTIVITY_KEY,
      title: '开宝箱活动',
      enabled: false,
      defaultKeyCount: 1,
      launchAt: new Date(),
    },
  });

  let created = 0;
  let updated = 0;
  for (const item of PRIZES) {
    // 按活动 + 奖品名幂等更新
    // eslint-disable-next-line no-await-in-loop
    const existed = await prisma.chestRewardItem.findFirst({
      where: { activityKey: ACTIVITY_KEY, name: item.name },
      select: { id: true },
    });
    if (existed?.id) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.chestRewardItem.update({
        where: { id: existed.id },
        data: item,
      });
      updated += 1;
    } else {
      // eslint-disable-next-line no-await-in-loop
      await prisma.chestRewardItem.create({
        data: { activityKey: ACTIVITY_KEY, ...item },
      });
      created += 1;
    }
  }

  const list = await prisma.chestRewardItem.findMany({
    where: { activityKey: ACTIVITY_KEY },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  const totalWeight = list
    .filter((i) => i.enabled && (i.stock === null || i.stock > 0))
    .reduce((sum, i) => sum + Math.max(0, Number(i.weight || 0)), 0);

  console.log(
    JSON.stringify(
      {
        ok: true,
        activityId: cfg.id,
        activityKey: ACTIVITY_KEY,
        created,
        updated,
        total: list.length,
        totalWeight,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
