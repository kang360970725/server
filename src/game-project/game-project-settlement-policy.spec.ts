import { BadRequestException } from '@nestjs/common';
import { BillingMode } from '@prisma/client';
import { GameProjectService } from './game-project.service';

describe('商品保底结算配置', () => {
  const db: any = { gameProject: { create: jest.fn(async ({ data }) => data),
    update: jest.fn(async ({ data }) => data), findUnique: jest.fn() } };
  const service = new GameProjectService(db, {} as any);

  beforeEach(() => jest.clearAllMocks());

  it('非体验保底商品新建时默认末轮最低 800 万', async () => {
    const result: any = await service.create({ name: '普通保底', price: 300, type: 'ESCORT', billingMode: BillingMode.GUARANTEED });
    expect(result).toMatchObject({ guaranteedSettlementMode: 'STANDARD', minimumFinalProgressWan: 800 });
  });

  it('全额模式自动清空最低进度，避免冲突配置', async () => {
    const result: any = await service.create({ name: '体验全额', price: 118, type: 'EXPERIENCE',
      billingMode: BillingMode.GUARANTEED, guaranteedSettlementMode: 'FINAL_ROUND_TAKES_ALL', minimumFinalProgressWan: 600 });
    expect(result).toMatchObject({ guaranteedSettlementMode: 'FINAL_ROUND_TAKES_ALL', minimumFinalProgressWan: null });
  });

  it('部分更新最低进度时保留已有策略', async () => {
    db.gameProject.findUnique.mockResolvedValue({ guaranteedSettlementMode: 'STANDARD', minimumFinalProgressWan: 600 });
    const result: any = await service.update(1, { minimumFinalProgressWan: 800 });
    expect(result).toMatchObject({ guaranteedSettlementMode: 'STANDARD', minimumFinalProgressWan: 800 });
  });

  it('拒绝未知模式和负数最低进度', async () => {
    await expect(service.create({ name: '错误', price: 1, type: 'EXPERIENCE',
      guaranteedSettlementMode: 'UNKNOWN' as any })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({ name: '错误', price: 1, type: 'EXPERIENCE',
      minimumFinalProgressWan: -1 })).rejects.toBeInstanceOf(BadRequestException);
  });
});
